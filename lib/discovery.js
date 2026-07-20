'use strict';

const net = require('net');

// onvif is only needed during discovery; lazy-require to keep memory low.
function loadOnvif() {
  try {
    // eslint-disable-next-line global-require
    return require('onvif');
  } catch (e) {
    return null;
  }
}

/**
 * ONVIF WS-Discovery: find ONVIF-compliant cameras on the local network.
 * @returns {Promise<Array<{ip:string, name:string, onvifPort:number}>>}
 */
function onvifProbe(timeout = 5000) {
  return new Promise((resolve) => {
    const onvif = loadOnvif();
    if (!onvif || !onvif.Discovery) return resolve([]);

    const found = [];
    const onDevice = (cam, rinfo) => {
      try {
        const ip = (cam && cam.hostname) || (rinfo && rinfo.address);
        if (!ip) return;
        found.push({
          ip,
          onvifPort: (cam && cam.port) || 80,
          name: (cam && cam.hostname) ? `ONVIF ${cam.hostname}` : `ONVIF ${ip}`,
        });
      } catch (e) { /* ignore malformed device */ }
    };

    try {
      onvif.Discovery.on('device', onDevice);
      onvif.Discovery.probe({ timeout, resolve: true }, () => {
        try { onvif.Discovery.removeListener('device', onDevice); } catch (e) { /* ignore */ }
        const uniq = {};
        found.forEach((f) => { uniq[f.ip] = f; });
        resolve(Object.values(uniq));
      });
    } catch (e) {
      resolve([]);
    }
  });
}

/**
 * Resolve the RTSP stream URI of an ONVIF camera (credentials usually required).
 * @returns {Promise<string>} the rtsp:// URL (with the camera's real port)
 */
function getRtspUri({ ip, onvifPort = 80, username = '', password = '' }, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const onvif = loadOnvif();
    if (!onvif || !onvif.Cam) return reject(new Error('ONVIF library not available'));
    // eslint-disable-next-line no-new
    const cam = new onvif.Cam({
      hostname: ip, port: onvifPort, username, password, timeout,
    }, (err) => {
      if (err) return reject(err);
      cam.getStreamUri({ protocol: 'RTSP' }, (e, stream) => {
        if (e) return reject(e);
        resolve(stream && stream.uri);
      });
    });
  });
}

/**
 * TCP scan a /24 subnet for open RTSP ports (fallback for non-ONVIF cameras).
 * @param {string} base24 e.g. "192.168.1"
 * @returns {Promise<Array<{ip:string, port:number}>>}
 */
function scanPorts(base24, ports = [554, 8554], timeout = 400, concurrency = 40) {
  const targets = [];
  for (let i = 1; i <= 254; i += 1) {
    for (const p of ports) targets.push({ ip: `${base24}.${i}`, port: p });
  }
  return new Promise((resolve) => {
    const results = [];
    let idx = 0;
    let active = 0;
    let done = false;

    const pump = () => {
      if (done) return;
      if (idx >= targets.length && active === 0) {
        done = true;
        return resolve(results);
      }
      while (active < concurrency && idx < targets.length) {
        const t = targets[idx];
        idx += 1;
        active += 1;
        const sock = new net.Socket();
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          active -= 1;
          try { sock.destroy(); } catch (e) { /* ignore */ }
          if (ok) results.push(t);
          pump();
        };
        sock.setTimeout(timeout);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        try { sock.connect(t.port, t.ip); } catch (e) { finish(false); }
      }
    };
    pump();
  });
}

module.exports = { onvifProbe, getRtspUri, scanPorts };
