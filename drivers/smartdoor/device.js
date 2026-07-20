'use strict';

const { Device } = require('homey');

const SENSOR_CAPS = ['alarm_motion', 'alarm_contact', 'alarm_generic'];

class SmartDoorDevice extends Device {

  async onInit() {
    this.log('Smart Door device initialized:', this.getName());
    await this.ensureCapabilities();

    this.settings = this.getSettings();
    this.api = this.homey.app.api;
    this._instances = [];

    // Bottom UI: lock/unlock button -> relay to the mapped lock device
    this.registerCapabilityListener('locked', async (value) => this.setLock(value));

    await this.setupCamera();
    await this.setupLinkedDevices();
  }

  /** Add capabilities added to the driver after this device was paired. */
  async ensureCapabilities() {
    const caps = (this.driver.manifest && this.driver.manifest.capabilities) || [];
    for (const cap of caps) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }
  }

  // ---- Camera (RTSP) --------------------------------------------------------

  async setupCamera() {
    if (!this.settings.rtsp_url) {
      this.log('No RTSP URL configured; skipping camera');
      return;
    }
    try {
      this.cameraImage = await this.homey.images.createImage();
      this.cameraImage.setStream(async (stream) => this.pipeSnapshot(stream));
      await this.setCameraImage('rtsp', 'Live', this.cameraImage);
      this.log('Camera image registered');
    } catch (error) {
      this.error('Failed to set up camera:', error);
    }
  }

  /**
   * Write a JPEG snapshot of the RTSP stream to `stream`.
   *
   * TODO: implement RTSP -> JPEG frame extraction from `this.settings.rtsp_url`.
   * Homey's camera API is snapshot (image) based, so a single frame must be
   * grabbed and piped here. This needs a transcoding step (e.g. ffmpeg) or, if
   * the camera also exposes an HTTP snapshot endpoint, fetching that instead.
   */
  async pipeSnapshot(stream) {
    throw new Error('RTSP snapshot extraction is not implemented yet');
  }

  /** Flow action: refresh the snapshot. */
  async takeSnapshot() {
    if (!this.cameraImage) throw new Error('Camera not configured');
    await this.cameraImage.update();
  }

  // ---- Linked devices (lock + sensors) via HomeyAPI -------------------------

  async setupLinkedDevices() {
    if (!this.api) {
      this.error('Homey API not ready; linked devices disabled');
      return;
    }
    const { lock_id: lockId, doorbell_id: doorbellId, motion_id: motionId } = this.settings;

    // Door lock: mirror its state onto our `locked` capability
    if (lockId) {
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

    // Doorbell sensor -> alarm_generic + flow trigger
    if (doorbellId) {
      await this.subscribeAlarm(doorbellId, (on) => {
        this.setCapabilityValue('alarm_generic', on).catch(this.error);
        if (on) this.driver.triggerDoorbell(this);
      });
    }

    // Motion sensor -> alarm_motion + flow trigger
    if (motionId) {
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

  /** Relay lock/unlock to the mapped lock device. */
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
    // Re-wire camera / subscriptions after the handler resolves
    this.homey.setTimeout(async () => {
      try {
        if (changedKeys.includes('rtsp_url')) await this.setupCamera();
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
