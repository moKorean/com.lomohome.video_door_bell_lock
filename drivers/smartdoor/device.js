'use strict';

const { Device } = require('homey');

const SENSOR_CAPS = ['alarm_motion', 'alarm_contact', 'alarm_generic'];

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
    // Custom alarm capabilities (icons/titles come from their definitions).
    // System alarm_generic/alarm_motion can't have their icon overridden, so we
    // migrate away from them to custom ones that carry the MDI icons.
    await this._syncCap('alarm_generic', false, null);
    await this._syncCap('alarm_motion', false, null);
    await this._syncCap('alarm_doorbell', !!this.settings.doorbell_id, null);
    await this._syncCap('alarm_loitering', !!this.settings.motion_id, null);
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
      { url: s.rtsp_url, label: s.camera_name },
      { url: s.rtsp_url_2, label: s.camera_name_2 },
      { url: s.rtsp_url_3, label: s.camera_name_3 },
      { url: s.rtsp_url_4, label: s.camera_name_4 },
    ];
    return slots
      .map((c, i) => ({
        id: `cam${i + 1}`,
        url: (c.url || '').trim(),
        label: (c.label || '').trim() || `Camera ${i + 1}`,
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

    if (doorbellId && this.hasCapability('alarm_doorbell')) {
      await this.subscribeAlarm(doorbellId, 'alarm_doorbell', (on) => {
        if (on) this.driver.triggerDoorbell(this);
      });
    }

    if (motionId && this.hasCapability('alarm_loitering')) {
      await this.subscribeAlarm(motionId, 'alarm_loitering', (on) => {
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
