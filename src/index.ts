import fetch, { Request } from 'node-fetch';
import fs from 'fs';
import crypto from 'crypto';
import locko from 'locko';
import { NFCResponse } from './classes/response.js';
import { MemoryCache } from './classes/caching/memory_cache.js';
import { request } from 'http';

type FetchCacheOptions = {
  keyFlags?:KeyFlags
}
type KeyFlags = {
  cache?:Boolean
  credentials?:Boolean
  destination?:Boolean
  headers?:Boolean|Object
  integrity?:Boolean
  method?:Boolean
  redirect?:Boolean
  referrer?:Boolean
  referrerPolicy?:Boolean
  url?:Boolean
  body?:Boolean
}

const CACHE_VERSION = 4;
const DEFAULT_KEY_FLAGS:KeyFlags = {
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
}

let key_flags = DEFAULT_KEY_FLAGS;

function md5(str:string) {
  return crypto.createHash('md5').update(str).digest('hex');
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
      .filter(([key, value]) => 
        (key !== 'cache-control' || value !== 'only-if-cached') && 
        /* Either: 
          * we're just including headers entire (if key_flags.headers == false we shouldn't be here anyway)
          * or key_flags.headers is an object and doesn't include a directive for this header key (in which case include it by default)
          * or key_flags.headers is an object and we're not explicitly excluding this header key
          */
        (typeof key_flags.headers === 'boolean' || !key_flags.headers.hasOwnProperty(<PropertyKey>key) || key_flags.headers[<PropertyKey>key])
      ),
  );
}

function getBodyCacheKeyJson(body:any) {
  if (!body) {
    return body;
  } if (typeof body === 'string') {
    return body;
  } if (body instanceof URLSearchParams) {
    return body.toString();
  } if (body instanceof fs.ReadStream) {
    return body.path;
  } if (body.toString && body.toString() === '[object FormData]') {
    return getFormDataCacheKey(body);
  } if (body instanceof Buffer) {
    return body.toString();
  }

  throw new Error('Unsupported body type. Supported body types are: string, number, undefined, null, url.URLSearchParams, fs.ReadStream, FormData');
}

function getRequestCacheKey(req:any):KeyFlags {
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

export function getCacheKey(resource:any, init:Request = {}) {
  const resourceCacheKeyJson = resource instanceof Request
    ? getRequestCacheKey(resource)
    : getRequestCacheKey({ url: resource });

  const initCacheKeyJson = {
    ...init,
    headers: key_flags['headers'] ? getHeadersCacheKeyJson(init.headers || {}) : '',
  };

  resourceCacheKeyJson.body = getBodyCacheKeyJson(resourceCacheKeyJson.body);
  initCacheKeyJson.body = getBodyCacheKeyJson(initCacheKeyJson.body);

  delete initCacheKeyJson.agent;

  return md5(JSON.stringify([resourceCacheKeyJson, initCacheKeyJson, CACHE_VERSION]));
}

function hasOnlyWithCacheOption(resource:any, init:any) {
  if (
    init
    && init.headers
    && Object.entries(init.headers)
      .some(([key, value]) => key.toLowerCase() === 'cache-control' && value === 'only-if-cached')
  ) {
    return true;
  }

  if (resource instanceof Request && resource.headers.get('Cache-Control') === 'only-if-cached') {
    return true;
  }

  return false;
}

async function getResponse(cache:any, requestArguments:Request) {
  const cacheKey = getCacheKey(requestArguments.resource, requestArguments.init)
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

  if (hasOnlyWithCacheOption(requestArguments.resource, requestArguments.init)) {
    return undefined;
  }

  await locko.lock(cacheKey);
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

    const fetchResponse = await fetch(...requestArguments);
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
    locko.unlock(cacheKey);
  }
}

function createFetchWithCache(cache, options:FetchCacheOptions = {}) {
  const fetchCache = (...args) => getResponse(cache, args);
  fetchCache.withCache = createFetchWithCache;

  key_flags = Object.assign(DEFAULT_KEY_FLAGS, options.keyFlags);
  
  console.log('Created cache with options:', options);

  return fetchCache;
}

const defaultFetch = createFetchWithCache(new MemoryCache());

export default defaultFetch;
export const fetchBuilder = defaultFetch;
export { MemoryCache } from './classes/caching/memory_cache.js';
export { FileSystemCache } from './classes/caching/file_system_cache.js';
