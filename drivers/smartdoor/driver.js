'use strict';

const { Driver } = require('homey');

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

  /** Pairing: expose device lists to the custom configure view. */
  onPair(session) {
    session.setHandler('listLocks', async () => this.listByCapabilities(['locked']));
    session.setHandler('listSensors', async () => this.listByCapabilities(SENSOR_CAPS));
  }

  async listByCapabilities(caps) {
    const api = this.homey.app.api;
    if (!api) {
      this.error('Homey API not ready');
      return [];
    }
    const devices = await api.devices.getDevices();
    return Object.values(devices)
      .filter((d) => Array.isArray(d.capabilities) && d.capabilities.some((c) => caps.includes(c)))
      .map((d) => ({ id: d.id, name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

}

module.exports = SmartDoorDriver;
