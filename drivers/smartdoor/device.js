'use strict';

const { Device } = require('homey');

const SENSOR_CAPS = ['alarm_motion', 'alarm_contact', 'alarm_generic'];

class SmartDoorDevice extends Device {

  async onInit() {
    this.log('Smart Door device initialized:', this.getName());
    this.settings = this.getSettings();
    this.api = this.homey.app.api;
    this._instances = [];

    // UI adapts to what is linked: only add the capabilities that apply.
    await this.syncCapabilities();

    if (this.hasCapability('locked')) {
      this.registerCapabilityListener('locked', async (value) => this.setLock(value));
    }

    await this.setupVideo();
    await this.setupLinkedDevices();
  }

  // ---- Dynamic UI (capabilities per configuration) --------------------------

  async syncCapabilities() {
    await this._syncCap('locked', !!this.settings.lock_id, null);
    await this._syncCap('alarm_generic', !!this.settings.doorbell_id, { en: 'Doorbell', ko: '초인종' });
    await this._syncCap('alarm_motion', !!this.settings.motion_id, { en: 'Motion', ko: '모션' });
  }

  async _syncCap(cap, want, title) {
    const has = this.hasCapability(cap);
    if (want && !has) {
      await this.addCapability(cap).catch(this.error);
      if (title) await this.setCapabilityOptions(cap, { title }).catch(this.error);
    } else if (!want && has) {
      await this.removeCapability(cap).catch(this.error);
    }
  }

  // ---- Video (RTSP live stream, native — no transcoding) --------------------

  async setupVideo() {
    if (!this.settings.rtsp_url) {
      this.log('No RTSP URL configured; skipping video');
      return;
    }
    const videos = this.homey.videos;
    if (!videos || typeof videos.createVideoRTSP !== 'function') {
      this.error('Videos API not available; a newer Homey firmware is required for RTSP streaming');
      return;
    }
    try {
      this.video = await videos.createVideoRTSP({ url: this.settings.rtsp_url });
      await this.setCameraVideo('rtsp', this.getName(), this.video);
      this.log('RTSP video registered');
    } catch (error) {
      this.error('Failed to set up RTSP video:', error);
    }
  }

  /** Flow action: capture a still snapshot.
   * TODO: RTSP still-image capture (the live stream works natively, but a JPEG
   * snapshot needs a frame grab — use the camera's HTTP snapshot URL if it has
   * one, or a transcoding step). */
  async takeSnapshot() {
    throw new Error('Snapshot capture is not implemented yet');
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
        const current = lock.capabilitiesObj && lock.capabilitiesObj.locked;
        if (current && typeof current.value === 'boolean') {
          await this.setCapabilityValue('locked', current.value).catch(this.error);
        }
        this._instances.push(lock.makeCapabilityInstance('locked', (value) => {
          this.setCapabilityValue('locked', value === true).catch(this.error);
        }));
      } else {
        this.error('Mapped lock not found or has no locked capability');
      }
    }

    if (doorbellId && this.hasCapability('alarm_generic')) {
      await this.subscribeAlarm(doorbellId, (on) => {
        this.setCapabilityValue('alarm_generic', on).catch(this.error);
        if (on) this.driver.triggerDoorbell(this);
      });
    }

    if (motionId && this.hasCapability('alarm_motion')) {
      await this.subscribeAlarm(motionId, (on) => {
        this.setCapabilityValue('alarm_motion', on).catch(this.error);
        if (on) this.driver.triggerMotion(this);
      });
    }
  }

  async subscribeAlarm(deviceId, cb) {
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
    this._instances.push(dev.makeCapabilityInstance(cap, (value) => cb(value === true)));
    this.log(`Subscribed to ${cap} of ${dev.name}`);
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

  async onSettings({ newSettings, changedKeys }) {
    this.settings = newSettings;
    this.homey.setTimeout(async () => {
      try {
        await this.syncCapabilities();
        if (changedKeys.includes('rtsp_url')) await this.setupVideo();
        this.destroyInstances();
        await this.setupLinkedDevices();
      } catch (err) {
        this.error('Failed to apply settings:', err);
      }
    }, 500);
  }

  onDeleted() {
    this.destroyInstances();
  }

}

module.exports = SmartDoorDevice;
