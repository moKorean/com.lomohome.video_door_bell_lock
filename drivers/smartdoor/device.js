'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { Device } = require('homey');

const SENSOR_CAPS = ['alarm_motion', 'alarm_contact', 'alarm_generic'];

/** Pipe an HTTP(S) JPEG/PNG snapshot into a writable stream (supports basic auth). */
function fetchToStream(urlStr, writable, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('Invalid snapshot URL')); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const options = {};
    if (u.username || u.password) {
      options.auth = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    }
    // Strip credentials from the URL itself so only options.auth is used.
    const clean = `${u.protocol}//${u.host}${u.pathname}${u.search}`;
    const req = mod.get(clean, options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Snapshot HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(writable);
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('Snapshot request timed out')));
  });
}

class SmartDoorDevice extends Device {

  async onInit() {
    this.log('Smart Door device initialized:', this.getName());
    this.api = this.homey.app.api;
    this._instances = [];
    await this.applyConfig();
  }

  /**
   * (Re)apply the current settings: adapt the UI (capabilities), (re)register the
   * cameras, and (re)subscribe to the linked lock/sensors. Safe to call again
   * after settings change (device settings or a repair flow).
   */
  async applyConfig() {
    this.settings = this.getSettings();
    await this.syncCapabilities();
    this.ensureLockListener();
    await this.setupVideos();
    await this.setupImages();
    this.destroyInstances();
    await this.setupLinkedDevices();
  }

  ensureLockListener() {
    if (this._lockListener) return;
    if (this.hasCapability('locked')) {
      this.registerCapabilityListener('locked', async (value) => this.setLock(value));
      this._lockListener = true;
    }
  }

  // ---- Dynamic UI (capabilities per configuration) --------------------------

  async syncCapabilities() {
    // uiQuickAction surfaces the lock as a quick-toggle button on the device tile.
    await this._syncCap('locked', !!this.settings.lock_id, { uiQuickAction: true });
    // Migrate away from the old, non-indicator-eligible mirror.
    await this._syncCap('door_locked', false, null);
    // Only alarm_ booleans are eligible as tile indicators, so expose the lock
    // state as "unlocked" (on = door not locked → shows as a warning indicator).
    await this._syncCap('alarm_unlocked', !!this.settings.lock_id, null);
    await this._syncCap('alarm_generic', !!this.settings.doorbell_id, { title: { en: 'Doorbell', ko: '초인종' } });
    await this._syncCap('alarm_motion', !!this.settings.motion_id, { title: { en: 'Motion', ko: '모션' } });
  }

  async _syncCap(cap, want, options) {
    const has = this.hasCapability(cap);
    if (want && !has) {
      await this.addCapability(cap).catch(this.error);
    } else if (!want && has) {
      await this.removeCapability(cap).catch(this.error);
      return;
    }
    // Apply options whenever the capability should exist (also upgrades devices
    // paired before an option was introduced).
    if (want && options && this.hasCapability(cap)) {
      await this.setCapabilityOptions(cap, options).catch(this.error);
    }
  }

  // ---- Video (RTSP live stream, native — no transcoding) --------------------

  /** Configured cameras (up to 4), skipping empty URL slots. */
  cameraList() {
    const s = this.settings;
    const slots = [
      { url: s.rtsp_url, label: s.camera_name, snap: s.snapshot_url },
      { url: s.rtsp_url_2, label: s.camera_name_2, snap: s.snapshot_url_2 },
      { url: s.rtsp_url_3, label: s.camera_name_3, snap: s.snapshot_url_3 },
      { url: s.rtsp_url_4, label: s.camera_name_4, snap: s.snapshot_url_4 },
    ];
    return slots
      .map((c, i) => ({
        id: `cam${i + 1}`,
        url: (c.url || '').trim(),
        label: (c.label || '').trim() || `Camera ${i + 1}`,
        snapshotUrl: (c.snap || '').trim(),
      }))
      .filter((c) => c.url);
  }

  async setupVideos() {
    const videos = this.homey.videos;
    if (!videos || typeof videos.createVideoRTSP !== 'function') {
      this.error('Videos API not available; a newer Homey firmware is required for RTSP streaming');
      return;
    }
    this._videos = this._videos || {};
    const active = this.cameraList();
    const activeIds = new Set(active.map((c) => c.id));

    // Remove cameras that are no longer configured
    for (const id of Object.keys(this._videos)) {
      if (!activeIds.has(id)) {
        if (typeof this.unsetCameraVideo === 'function') await this.unsetCameraVideo(id).catch(() => {});
        try { await this._videos[id].unregister(); } catch (e) { /* ignore */ }
        delete this._videos[id];
      }
    }

    for (const cam of active) {
      try {
        // Recreate so a changed URL/label is picked up.
        if (this._videos[cam.id]) {
          try { await this._videos[cam.id].unregister(); } catch (e) { /* ignore */ }
        }
        const url = cam.url;
        const video = await videos.createVideoRTSP();
        // Homey requests the stream URL on demand via this listener.
        video.registerVideoUrlListener(async () => ({ url }));
        await this.setCameraVideo(cam.id, cam.label, video);
        this._videos[cam.id] = video;
        this.log(`RTSP video registered: ${cam.id} (${cam.label})`);
      } catch (error) {
        this.error(`Failed to set up video ${cam.id}:`, error);
      }
    }
  }

  // ---- Snapshot still images (Homey Image, usable as a Flow token) ----------

  /** Create/refresh the Homey Image for a camera; its source is the snapshot URL. */
  async ensureImage(cam) {
    this._images = this._images || {};
    let image = this._images[cam.id];
    if (!image) {
      image = await this.homey.images.createImage();
      this._images[cam.id] = image;
    }
    const url = cam.snapshotUrl;
    image.setStream(async (stream) => { await fetchToStream(url, stream); });
    return image;
  }

  /** Register a snapshot Image (and tile thumbnail) for every camera that has a URL. */
  async setupImages() {
    if (!this.homey.images || typeof this.homey.images.createImage !== 'function') return;
    this._images = this._images || {};
    const withSnap = this.cameraList().filter((c) => c.snapshotUrl);
    const keep = new Set(withSnap.map((c) => c.id));

    for (const id of Object.keys(this._images)) {
      if (!keep.has(id)) {
        if (typeof this.unsetCameraImage === 'function') await this.unsetCameraImage(id).catch(() => {});
        delete this._images[id];
      }
    }

    for (const cam of withSnap) {
      try {
        const image = await this.ensureImage(cam);
        if (typeof this.setCameraImage === 'function') {
          await this.setCameraImage(cam.id, cam.label, image).catch((e) => this.error('setCameraImage failed:', e));
        }
        this.log(`Snapshot image registered: ${cam.id} (${cam.label})`);
      } catch (error) {
        this.error(`Failed to set up snapshot image ${cam.id}:`, error);
      }
    }
  }

  /**
   * Flow action: capture a fresh still snapshot and return it as a Homey Image
   * (usable as an image token in other Flow cards, e.g. a push notification).
   */
  async takeSnapshot(camId) {
    const cams = this.cameraList();
    const cam = camId
      ? cams.find((c) => c.id === camId)
      : (cams.find((c) => c.snapshotUrl) || cams[0]);
    if (!cam) throw new Error('No camera is configured');
    if (!cam.snapshotUrl) {
      throw new Error('No snapshot URL for this camera. Add it in the device settings (Snapshot URL).');
    }
    const image = await this.ensureImage(cam);
    await image.update();
    return image;
  }

  // ---- Linked devices (lock + sensors) via HomeyAPI -------------------------

  async setupLinkedDevices() {
    if (!this.api) {
      this.error('Homey API not ready; linked devices disabled');
      return;
    }
    const { lock_id: lockId, doorbell_id: doorbellId, motion_id: motionId } = this.settings;

    if (lockId && this.hasCapability('locked')) {
      const lock = await this.api.devices.getDevice({ id: lockId }).catch(() => null);
      if (lock && lock.capabilities.includes('locked')) {
        const mirror = (v) => {
          this.setCapabilityValue('locked', v).catch(this.error);
          if (this.hasCapability('alarm_unlocked')) this.setCapabilityValue('alarm_unlocked', !v).catch(this.error);
        };
        const current = lock.capabilitiesObj && lock.capabilitiesObj.locked;
        if (current && typeof current.value === 'boolean') mirror(current.value);
        this._instances.push(lock.makeCapabilityInstance('locked', (value) => mirror(value === true)));
        await lock.connect()
          .then(() => this.log(`Subscribed to locked of ${lock.name} (realtime)`))
          .catch((e) => this.error('realtime connect failed:', lock.name, e));
      } else {
        this.error('Mapped lock not found or has no locked capability');
      }
    }

    if (doorbellId && this.hasCapability('alarm_generic')) {
      await this.subscribeAlarm(doorbellId, 'alarm_generic', (on) => {
        if (on) this.driver.triggerDoorbell(this);
      });
    }

    if (motionId && this.hasCapability('alarm_motion')) {
      await this.subscribeAlarm(motionId, 'alarm_motion', (on) => {
        if (on) this.driver.triggerMotion(this);
      });
    }
  }

  /**
   * Mirror a linked sensor's alarm onto our capability `targetCap`. The current
   * value is applied immediately (so a reconfigured sensor shows its state right
   * away) without firing the flow; `onActive` runs only on live changes.
   */
  async subscribeAlarm(deviceId, targetCap, onActive) {
    const dev = await this.api.devices.getDevice({ id: deviceId }).catch(() => null);
    if (!dev) {
      this.error('Mapped sensor not found:', deviceId);
      return;
    }
    const cap = SENSOR_CAPS.find((c) => dev.capabilities.includes(c));
    if (!cap) {
      this.error('Mapped sensor has no supported alarm capability:', deviceId);
      return;
    }
    const apply = (on) => this.setCapabilityValue(targetCap, on).catch(this.error);

    const current = dev.capabilitiesObj && dev.capabilitiesObj[cap];
    if (current && typeof current.value === 'boolean') apply(current.value);

    const inst = dev.makeCapabilityInstance(cap, (value) => {
      const on = value === true;
      apply(on);
      onActive(on);
    });
    this._instances.push(inst);
    // makeCapabilityInstance connects lazily and swallows errors; await it so the
    // realtime subscription is actually established (otherwise updates fall back
    // to slow polling) and any failure is logged.
    await dev.connect()
      .then(() => this.log(`Subscribed to ${cap} of ${dev.name} -> ${targetCap} (realtime)`))
      .catch((e) => this.error('realtime connect failed:', dev.name, e));
  }

  async setLock(value) {
    if (!this.api || !this.settings.lock_id) {
      throw new Error('No door lock is linked');
    }
    await this.api.devices.setCapabilityValue({
      deviceId: this.settings.lock_id,
      capabilityId: 'locked',
      value,
    });
  }

  destroyInstances() {
    for (const inst of this._instances || []) {
      try { inst.destroy(); } catch (e) { /* ignore */ }
    }
    this._instances = [];
  }

  async onSettings({ newSettings }) {
    // getSettings() is not updated until this handler resolves, so re-apply on
    // the next tick once the new values are committed.
    this.homey.setTimeout(() => {
      this.applyConfig().catch((err) => this.error('Failed to apply settings:', err));
    }, 500);
  }

  onDeleted() {
    this.destroyInstances();
  }

}

module.exports = SmartDoorDevice;
