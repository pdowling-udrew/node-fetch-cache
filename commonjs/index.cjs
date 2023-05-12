'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var fetch = require('node-fetch');
var fs = require('fs');
var crypto = require('crypto');
var locko = require('locko');
var stream = require('stream');
var cacache = require('cacache');

function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

var fetch__default = /*#__PURE__*/_interopDefaultLegacy(fetch);
var fs__default = /*#__PURE__*/_interopDefaultLegacy(fs);
var crypto__default = /*#__PURE__*/_interopDefaultLegacy(crypto);
var locko__default = /*#__PURE__*/_interopDefaultLegacy(locko);
var cacache__default = /*#__PURE__*/_interopDefaultLegacy(cacache);

const responseInternalSymbol = Object.getOwnPropertySymbols(new fetch.Response())[1];

class NFCResponse extends fetch.Response {
  constructor(bodyStream, metaData, ejectFromCache, fromCache) {
    super(bodyStream, metaData);
    this.ejectFromCache = ejectFromCache;
    this.fromCache = fromCache;
  }

  static serializeMetaFromNodeFetchResponse(res) {
    const metaData = {
      url: res.url,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers.raw(),
      size: res.size,
      timeout: res.timeout,
      counter: res[responseInternalSymbol].counter,
    };

    return metaData;
  }

  ejectFromCache() {
    return this.ejectSelfFromCache();
  }
}

class KeyTimeout {
  constructor() {
    this.timeoutHandleForKey = {};
  }

  clearTimeout(key) {
    clearTimeout(this.timeoutHandleForKey[key]);
  }

  updateTimeout(key, durationMs, callback) {
    this.clearTimeout(key);
    this.timeoutHandleForKey[key] = setTimeout(() => {
      callback();
    }, durationMs);
  }
}

function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

class MemoryCache {
  constructor(options = {}) {
    this.ttl = options.ttl;
    this.keyTimeout = new KeyTimeout();
    this.cache = {};
  }

  get(key) {
    const cachedValue = this.cache[key];
    if (cachedValue) {
      return {
        bodyStream: stream.Readable.from(cachedValue.bodyBuffer),
        metaData: cachedValue.metaData,
      };
    }

    return undefined;
  }

  remove(key) {
    this.keyTimeout.clearTimeout(key);
    delete this.cache[key];
  }

  async set(key, bodyStream, metaData) {
    const bodyBuffer = await streamToBuffer(bodyStream);
    this.cache[key] = { bodyBuffer, metaData };

    if (typeof this.ttl === 'number') {
      this.keyTimeout.updateTimeout(key, this.ttl, () => this.remove(key));
    }

    return this.get(key);
  }
}

function getBodyAndMetaKeys(key) {
  return [`${key}body`, `${key}meta`];
}

class FileSystemCache {
  constructor(options = {}) {
    this.ttl = options.ttl;
    this.cacheDirectory = options.cacheDirectory || '.cache';
  }

  async get(key) {
    const [, metaKey] = getBodyAndMetaKeys(key);

    const metaInfo = await cacache__default["default"].get.info(this.cacheDirectory, metaKey);

    if (!metaInfo) {
      return undefined;
    }

    const metaBuffer = await cacache__default["default"].get.byDigest(this.cacheDirectory, metaInfo.integrity);
    const metaData = JSON.parse(metaBuffer);
    const { bodyStreamIntegrity, empty, expiration } = metaData;

    delete metaData.bodyStreamIntegrity;
    delete metaData.empty;
    delete metaData.expiration;

    if (expiration && expiration < Date.now()) {
      return undefined;
    }

    const bodyStream = empty
      ? stream.Readable.from(Buffer.alloc(0))
      : cacache__default["default"].get.stream.byDigest(this.cacheDirectory, bodyStreamIntegrity);

    return {
      bodyStream,
      metaData,
    };
  }

  remove(key) {
    const [bodyKey, metaKey] = getBodyAndMetaKeys(key);

    return Promise.all([
      cacache__default["default"].rm.entry(this.cacheDirectory, bodyKey),
      cacache__default["default"].rm.entry(this.cacheDirectory, metaKey),
    ]);
  }

  async set(key, bodyStream, metaData) {
    const [bodyKey, metaKey] = getBodyAndMetaKeys(key);
    const metaCopy = { ...metaData };

    if (typeof this.ttl === 'number') {
      metaCopy.expiration = Date.now() + this.ttl;
    }

    try {
      metaCopy.bodyStreamIntegrity = await new Promise((fulfill, reject) => {
        bodyStream.pipe(cacache__default["default"].put.stream(this.cacheDirectory, bodyKey))
          .on('integrity', (i) => fulfill(i))
          .on('error', (e) => {
            reject(e);
          });
      });
    } catch (err) {
      if (err.code !== 'ENODATA') {
        throw err;
      }

      metaCopy.empty = true;
    }

    const metaBuffer = Buffer.from(JSON.stringify(metaCopy));
    await cacache__default["default"].put(this.cacheDirectory, metaKey, metaBuffer);
    const cachedData = await this.get(key);

    return cachedData;
  }
}

const CACHE_VERSION = 4;
const DEFAULT_KEY_FLAGS = {
  cache: true,
  credentials: true,
  destination: true,
  headers: true,
  integrity: true,
  method: true,
  redirect: true,
  referrer: true,
  referrerPolicy: true,
  url: true,
  body: true,
};

let key_flags = DEFAULT_KEY_FLAGS;

function md5(str) {
  return crypto__default["default"].createHash('md5').update(str).digest('hex');
}

// Since the bounday in FormData is random,
// we ignore it for purposes of calculating
// the cache key.
function getFormDataCacheKey(formData) {
  const cacheKey = { ...formData };
  const boundary = formData.getBoundary();

  // eslint-disable-next-line no-underscore-dangle
  delete cacheKey._boundary;

  const boundaryReplaceRegex = new RegExp(boundary, 'g');

  // eslint-disable-next-line no-underscore-dangle
  cacheKey._streams = cacheKey._streams.map((s) => {
    if (typeof s === 'string') {
      return s.replace(boundaryReplaceRegex, '');
    }

    return s;
  });

  return cacheKey;
}

function getHeadersCacheKeyJson(headersObj) {
  return Object.fromEntries(
    Object.entries(headersObj)
      .map(([key, value]) => [key.toLowerCase(), value])
      .filter(([key, value]) => key !== 'cache-control' || value !== 'only-if-cached'),
  );
}

function getBodyCacheKeyJson(body) {
  if (!body) {
    return body;
  } if (typeof body === 'string') {
    return body;
  } if (body instanceof URLSearchParams) {
    return body.toString();
  } if (body instanceof fs__default["default"].ReadStream) {
    return body.path;
  } if (body.toString && body.toString() === '[object FormData]') {
    return getFormDataCacheKey(body);
  } if (body instanceof Buffer) {
    return body.toString();
  }

  throw new Error('Unsupported body type. Supported body types are: string, number, undefined, null, url.URLSearchParams, fs.ReadStream, FormData');
}

function getRequestCacheKey(req) {
  const headersPojo = Object.fromEntries([...req.headers.entries()]);

  return {
    cache: key_flags['cache'] ? req.cache : '',
    credentials: key_flags['credentials'] ? req.credentials : '',
    destination: key_flags['destination'] ? req.destination : '',
    headers: key_flags['headers'] ? getHeadersCacheKeyJson(headersPojo) : '',
    integrity: key_flags['integrity'] ? req.integrity : '',
    method: key_flags['method'] ? req.method : '',
    redirect: key_flags['redirect'] ? req.redirect : '',
    referrer: key_flags['referrer'] ? req.referrer : '',
    referrerPolicy: key_flags['referrerPolicy'] ? req.referrerPolicy : '',
    url: key_flags['url'] ? req.url : '',
    body: key_flags['body'] ? getBodyCacheKeyJson(req.body) : '',
  };
}

function getCacheKey(resource, init = {}) {
  const resourceCacheKeyJson = resource instanceof fetch.Request
    ? getRequestCacheKey(resource)
    : { url: resource };

  const initCacheKeyJson = {
    ...init,
    headers: getHeadersCacheKeyJson(init.headers || {}),
  };

  resourceCacheKeyJson.body = getBodyCacheKeyJson(resourceCacheKeyJson.body);
  initCacheKeyJson.body = getBodyCacheKeyJson(initCacheKeyJson.body);

  delete initCacheKeyJson.agent;

  return md5(JSON.stringify([resourceCacheKeyJson, initCacheKeyJson, CACHE_VERSION]));
}

function hasOnlyWithCacheOption(resource, init) {
  if (
    init
    && init.headers
    && Object.entries(init.headers)
      .some(([key, value]) => key.toLowerCase() === 'cache-control' && value === 'only-if-cached')
  ) {
    return true;
  }

  if (resource instanceof fetch.Request && resource.headers.get('Cache-Control') === 'only-if-cached') {
    return true;
  }

  return false;
}

async function getResponse(cache, requestArguments) {
  const cacheKey = getCacheKey(...requestArguments);
  let cachedValue = await cache.get(cacheKey);

  const ejectSelfFromCache = () => cache.remove(cacheKey);

  if (cachedValue) {
    return new NFCResponse(
      cachedValue.bodyStream,
      cachedValue.metaData,
      ejectSelfFromCache,
      true,
    );
  }

  if (hasOnlyWithCacheOption(...requestArguments)) {
    return undefined;
  }

  await locko__default["default"].lock(cacheKey);
  try {
    cachedValue = await cache.get(cacheKey);
    if (cachedValue) {
      return new NFCResponse(
        cachedValue.bodyStream,
        cachedValue.metaData,
        ejectSelfFromCache,
        true,
      );
    }

    const fetchResponse = await fetch__default["default"](...requestArguments);
    const serializedMeta = NFCResponse.serializeMetaFromNodeFetchResponse(fetchResponse);

    const newlyCachedData = await cache.set(
      cacheKey,
      fetchResponse.body,
      serializedMeta,
    );

    return new NFCResponse(
      newlyCachedData.bodyStream,
      newlyCachedData.metaData,
      ejectSelfFromCache,
      false,
    );
  } finally {
    locko__default["default"].unlock(cacheKey);
  }
}

function createFetchWithCache(cache, options = {}) {
  const fetchCache = (...args) => getResponse(cache, args);
  fetchCache.withCache = createFetchWithCache;

  key_flags = Object.assign(DEFAULT_KEY_FLAGS, options.keyFlags);

  return fetchCache;
}

const defaultFetch = createFetchWithCache(new MemoryCache());
const fetchBuilder = defaultFetch;

exports.FileSystemCache = FileSystemCache;
exports.MemoryCache = MemoryCache;
exports["default"] = defaultFetch;
exports.fetchBuilder = fetchBuilder;
exports.getCacheKey = getCacheKey;
