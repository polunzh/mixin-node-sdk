const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const Uint64LE = require('int64-buffer').Uint64LE;
const debug = require('debug')('MixinSDK');

const AES_BLOCK_SIZE = 16;

class MixinSDK {
  constructor({
    clientId,
    clientSecret,
    assetPin,
    aesKey,
    sessionId,
    privateKey,
    shareSecret = '',
    timeout = 3600
  }) {
    // accept options
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.assetPin = assetPin;
    this.aesKey = aesKey;
    this.sessionId = sessionId;

    this.timeout = timeout;
    this.shareSecret = shareSecret;

    if (typeof privateKey == 'string' && fs.existsSync(privateKey)) {
      this.privateKey = fs.readFileSync(privateKey);
    } else if (typeof privateKey == 'object') {
      this.privateKey = privateKey;
    }

    // validate options
    const requiredOptions = [
      'clientId',
      'clientSecret',
      'assetPin',
      'aesKey',
      'sessionId',
      'privateKey'
    ];
    for (const key of requiredOptions) {
      if (!this[key]) {
        throw new Error(`${key} param is required to create an MixinSDK instance`);
      }
    }

    this.axios = axios.create({
      baseURL: 'https://api.mixin.one',
      timeout: 60000
    });

    // TODO: initialize methods
  }

  getEncryptedPin(assetPin) {
    const now = Date.now(); // TODO: read the global iterator value, and +1
    const seconds = Math.floor(now / 1000);
    const pinBuffer = Buffer.concat([
      Buffer.from(assetPin, 'utf8'),
      new Uint64LE(seconds).toBuffer(),
      new Uint64LE(now).toBuffer()
    ]);

    const paddingSize = AES_BLOCK_SIZE - (pinBuffer.length % AES_BLOCK_SIZE);
    const paddingArray = [];
    for (let i = 0; i < paddingSize; i++) {
      paddingArray.push(paddingSize);
    }
    const paddingBuffer = new Buffer(paddingArray);

    const encryptBuffer = Buffer.concat([pinBuffer, paddingBuffer]);
    const aesKey = new Buffer(this.aesKey, 'base64');
    const iv16 = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv16);
    cipher.setAutoPadding(false);
    const encryptedPinBuffer = cipher.update(encryptBuffer, 'utf-8');
    return Buffer.from(Buffer.concat([iv16, encryptedPinBuffer])).toString('base64');
  }

  getUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = (Math.random() * 16) | 0,
        v = c == 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  getConversationId(userId, recipientId) {
    userId = userId.toString();
    recipientId = recipientId.toString();

    let [minId, maxId] = [userId, recipientId];
    if (minId > maxId) {
      [minId, maxId] = [recipientId, userId];
    }

    const hash = crypto.createHash('md5');
    hash.update(minId);
    hash.update(maxId);
    const bytes = hash.digest();

    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const digest = Array.from(bytes, function(byte) {
      return ('0' + (byte & 0xff).toString(16)).slice(-2);
    }).join('');

    const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(
      12,
      16
    )}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    return uuid;
  }

  getRequestSignature(method, uri, body) {
    const payload =
      method + uri + (typeof body === 'object' ? JSON.stringify(body) : body.toString());
    const signature = crypto
      .createHash('sha256')
      .update(payload)
      .digest('hex');

    debug('getRequestSignature', { method, uri, body, payload, signature });
    return signature;
  }

  getJwtToken(method, uri, body) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expireAt = issuedAt + this.timeout;
    const payload = {
      uid: this.clientId,
      sid: this.sessionId,
      iat: issuedAt,
      exp: expireAt,
      jti: this.getUUID(),
      sig: this.getRequestSignature(method, uri, body)
    };
    const token = jwt.sign(payload, this.privateKey, { algorithm: 'RS512' });
    debug('getJwtToken', { method, uri, body, payload, token });

    return token;
  }

  async getAccessToken(code) {
    const payload = {
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret
    };
    const res = await this.axios.post('/oauth/token', payload);
    return res.data;
  }

  async doRequest(method, endpoint, payload) {
    const methodUpper = method.toUpperCase();
    const methodLower = method.toLowerCase();
    const token = this.getJwtToken(methodUpper, endpoint, payload);
    const res = await this.axios({
      method: methodLower,
      url: endpoint,
      data: payload,
      headers: {
        Authorization: 'Bearer ' + token
      }
    });

    debug('doRequest', { method, endpoint, payload, response: res.data });
    return res.data;
  }

  async transferFromBot({ assetId, recipientId, amount, memo = '' }) {
    const payload = {
      asset_id: assetId,
      counter_user_id: recipientId,
      amount: amount.toString(),
      pin: this.getEncryptedPin(this.assetPin),
      trace_id: this.getUUID()
    };

    if (memo !== '') {
      payload.memo = memo;
    }

    const data = await this.doRequest('POST', '/transfers', payload);
    return data;
  }

  async getAssets() {
    const data = await this.doRequest('GET', '/assets', '');
    return data;
  }

  async getAsset(assetId) {
    const data = await this.doRequest('GET', `/assets/${assetId}`, '');
    return data;
  }
}

module.exports = MixinSDK;
