'use strict';

const { Driver } = require('homey');
const discovery = require('../../lib/discovery');

const SENSOR_CAPS = ['alarm_motion', 'alarm_contact', 'alarm_generic'];

class SmartDoorDriver extends Driver {

  async onInit() {
    this.log('Smart Door driver initialized');

    this.doorbellTrigger = this.homey.flow.getDeviceTriggerCard('doorbell_rang');
    this.motionTrigger = this.homey.flow.getDeviceTriggerCard('motion_detected');

    this.homey.flow.getConditionCard('lock_is_locked')
      .registerRunListener(async (args) => args.device.getCapabilityValue('locked') === true);

    this.homey.flow.getActionCard('take_snapshot')
      .registerRunListener(async (args) => args.device.takeSnapshot());
  }

  async triggerDoorbell(device) {
    await this.doorbellTrigger.trigger(device).catch(this.error);
  }

  async triggerMotion(device) {
    await this.motionTrigger.trigger(device).catch(this.error);
  }

  /** Pairing: expose device lists + camera discovery to the configure view. */
  onPair(session) {
    this.log('[PAIR] onPair session started');
    session.setHandler('uilog', async (msg) => {
      this.log('[UI]', msg);
      return true;
    });
    session.setHandler('listLocks', async () => {
      this.log('[PAIR] listLocks called');
      return this.listByCapabilities(['locked']);
    });
    session.setHandler('listSensors', async () => {
      this.log('[PAIR] listSensors called');
      return this.listByCapabilities(SENSOR_CAPS);
    });
    session.setHandler('discoverCameras', async () => {
      this.log('[PAIR] discoverCameras called');
      return this.discoverCameras();
    });
    session.setHandler('resolveStreamUri', async (data) => {
      this.log('[PAIR] resolveStreamUri called for', data && data.ip);
      return discovery.getRtspUri(data);
    });
  }

  /** Local /24 subnet prefix, e.g. "192.168.1", from Homey's local address. */
  async localSubnet24() {
    try {
      const addr = await this.homey.cloud.getLocalAddress();
      const ip = String(addr).split(':')[0];
      const m = ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  /** Discover RTSP cameras: ONVIF WS-Discovery + a 554/8554 port scan fallback. */
  async discoverCameras() {
    const onvifCams = await discovery.onvifProbe(5000).catch((e) => {
      this.error('ONVIF probe failed:', e);
      return [];
    });
    const base = await this.localSubnet24();
    const scanned = base
      ? await discovery.scanPorts(base, [554, 8554], 400, 40).catch(() => [])
      : [];

    const map = {};
    onvifCams.forEach((c) => {
      map[c.ip] = { ip: c.ip, name: c.name, onvifPort: c.onvifPort, onvif: true };
    });
    scanned.forEach((s) => {
      map[s.ip] = map[s.ip] || { ip: s.ip, name: `RTSP ${s.ip}`, onvif: false };
      map[s.ip].rtspPort = map[s.ip].rtspPort || s.port;
    });
    const list = Object.values(map);
    this.log(`discoverCameras -> onvif:${onvifCams.length} scan:${scanned.length} total:${list.length}`);
    return list;
  }

  async listByCapabilities(caps) {
    const api = await this.homey.app.getApi().catch(() => null);
    if (!api) {
      this.error('Homey API not ready while listing devices');
      throw new Error('Homey API not ready. Please try again in a moment.');
    }
    const devices = await api.devices.getDevices();
    const list = Object.values(devices)
      .filter((d) => Array.isArray(d.capabilities) && d.capabilities.some((c) => caps.includes(c)))
      .map((d) => ({ id: d.id, name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.log(`listByCapabilities(${caps.join(',')}) -> ${list.length} devices`);
    return list;
  }

}

module.exports = SmartDoorDriver;
