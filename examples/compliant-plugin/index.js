'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const CACHE = path.join(__dirname, 'cache');

function activate() {
  fs.mkdirSync(CACHE, { recursive: true });
}

function invoke(action) {
  if (action === 'read-cache') {
    return { mode: process.env.DSH_DEMO_MODE || 'default' };
  }
  if (action === 'fetch') {
    return new Promise((resolve, reject) => {
      https.get('https://api.example.com:443/v1/status', (response) => {
        response.resume();
        resolve({ status: response.statusCode });
      }).on('error', reject);
    });
  }
  return { ok: true, action };
}

function deactivate() {}

module.exports = { activate, invoke, deactivate };
