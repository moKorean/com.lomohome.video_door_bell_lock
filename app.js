/*
 * Video Doorbell Lock
 * Copyright 2026, Geunwon Mo (mokorean@gmail.com)
 */

'use strict';

const Homey = require('homey');

// Import only the HomeyAPI submodule to avoid loading the unused Athom Cloud
// API clients (much smaller memory footprint). Fall back to the package root.
let HomeyAPI;
try {
  HomeyAPI = require('homey-api/lib/HomeyAPI/HomeyAPI');
} catch (err) {
  ({ HomeyAPI } = require('homey-api'));
}

class VideoDoorbellLockApp extends Homey.App {

  async onInit() {
    try {
      await this.initApi();
      this.log('Video Doorbell Lock app is running...');
    } catch (error) {
      this.error(error);
    }
  }

  async onUninit() {
    if (this.apiRetryId) this.homey.clearTimeout(this.apiRetryId);
  }

  /** Return the HomeyAPI, connecting on demand if it isn't ready yet. */
  async getApi() {
    if (this.api) return this.api;
    await this.initApi();
    return this.api;
  }

  async initApi() {
    if (this.apiRetryId) this.homey.clearTimeout(this.apiRetryId);
    try {
      this.api = await Promise.race([
        HomeyAPI.createAppAPI({ homey: this.homey }),
        new Promise((resolve, reject) => {
          this.homey.setTimeout(() => reject(new Error('HomeyAPI.createAppAPI timeout')), 10000);
        }),
      ]);
      this.log('HomeyAPI connected');
    } catch (err) {
      this.error('HomeyAPI init failed, retrying in 1 min:', err);
      this.apiRetryId = this.homey.setTimeout(() => this.initApi(), 60000);
    }
  }

}

module.exports = VideoDoorbellLockApp;
