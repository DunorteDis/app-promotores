export type BridgeRequest = {
  id: string;
  type:
    | 'battery.get'
    | 'battery.subscribe'
    | 'battery.unsubscribe'
    | 'location.get'
    | 'location.watch'
    | 'location.unwatch'
    | 'network.get'
    | 'network.subscribe'
    | 'network.unsubscribe'
    | 'notifications.requestPermission'
    | 'notifications.schedule'
    | 'media.capture'
    | 'media.pick'
    | 'media.captureSession'
    | 'media.openFile';
  payload?: Record<string, unknown>;
};

export type BridgeResponse = {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type BridgeEvent = {
  event:
    | 'battery.update'
    | 'location.update'
    | 'network.update'
    | 'notification.received'
    | 'notification.response';
  data: unknown;
};

export const INJECTED_JS = `
(function () {
  if (window.DunorteNative && window.DunorteNative.__ready) return;

  var listeners = {};
  var pending = {};
  var idCounter = 0;

  function nextId() {
    idCounter += 1;
    return 'req_' + Date.now() + '_' + idCounter;
  }

  function post(message) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  function request(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = nextId();
      pending[id] = { resolve: resolve, reject: reject };
      post({ id: id, type: type, payload: payload || {} });
    });
  }

  function handleMessage(raw) {
    try {
      var msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (msg && msg.id && pending[msg.id]) {
        var p = pending[msg.id];
        delete pending[msg.id];
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error || 'Erro desconhecido'));
        return;
      }
      if (msg && msg.event && listeners[msg.event]) {
        listeners[msg.event].forEach(function (cb) {
          try { cb(msg.data); } catch (e) { /* noop */ }
        });
      }
    } catch (err) { /* noop */ }
  }

  window.DunorteNative = {
    __ready: true,
    platform: 'react-native',
    getBattery: function () { return request('battery.get'); },
    subscribeBattery: function () { return request('battery.subscribe'); },
    unsubscribeBattery: function () { return request('battery.unsubscribe'); },
    getLocation: function () { return request('location.get'); },
    watchLocation: function () { return request('location.watch'); },
    unwatchLocation: function () { return request('location.unwatch'); },
    getNetwork: function () { return request('network.get'); },
    subscribeNetwork: function () { return request('network.subscribe'); },
    unsubscribeNetwork: function () { return request('network.unsubscribe'); },
    requestNotificationPermission: function () { return request('notifications.requestPermission'); },
    scheduleNotification: function (payload) { return request('notifications.schedule', payload); },
    captureSession: function (payload) { return request('media.captureSession', payload || {}); },
    openFile: function (payload) { return request('media.openFile', payload || {}); },
    on: function (event, cb) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
      return function off() {
        listeners[event] = (listeners[event] || []).filter(function (fn) { return fn !== cb; });
      };
    },
    __handleMessage: handleMessage,
  };

  document.addEventListener('message', function (e) { handleMessage(e.data); });
  window.addEventListener('message', function (e) { handleMessage(e.data); });

  // --- File input interception ---
  // Intercepts <input type="file"> clicks so the native image picker handles them
  // instead of the WebView's (broken) file chooser. Files are returned as base64
  // and injected back into the input via DataTransfer so React sees the change.
  var _pendingFileInput = null;

  function injectFilesIntoInput(input, files) {
    try {
      var dt = new DataTransfer();
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var byteStr = atob(f.base64 || '');
        var ab = new ArrayBuffer(byteStr.length);
        var view = new Uint8Array(ab);
        for (var j = 0; j < byteStr.length; j++) view[j] = byteStr.charCodeAt(j);
        dt.items.add(new File([ab], f.fileName || 'photo.jpg', { type: f.mimeType || 'image/jpeg' }));
      }
      try {
        Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
      } catch (e2) { /* noop */ }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) { /* noop */ }
  }

  function handleFileInput(input) {
    var wantsCamera = input.hasAttribute('capture');
    var id = nextId();
    _pendingFileInput = input;
    pending[id] = {
      resolve: function (data) {
        if (data && data.files && data.files.length > 0 && _pendingFileInput) {
          injectFilesIntoInput(_pendingFileInput, data.files);
        }
        _pendingFileInput = null;
      },
      reject: function () { _pendingFileInput = null; },
    };
    post({ id: id, type: wantsCamera ? 'media.capture' : 'media.pick', payload: { multiple: !!input.multiple } });
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el) {
      if (el.tagName === 'INPUT' && el.type === 'file') break;
      el = el.parentElement;
    }
    if (!el) return;
    e.preventDefault();
    handleFileInput(el);
  }, true);

  // --- Battery Status API polyfill ---
  // iOS/WebKit não implementa navigator.getBattery(). Fazemos um shim que
  // delega para a ponte nativa e dispara os mesmos eventos do spec.
  function createBatteryManager(initial) {
    var target = typeof EventTarget === 'function' ? new EventTarget() : null;
    var handlers = { levelchange: [], chargingchange: [], chargingtimechange: [], dischargingtimechange: [] };

    function snapshotToState(snap) {
      var charging = snap.state === 'charging' || snap.state === 'full';
      return {
        level: typeof snap.level === 'number' ? snap.level : (snap.percent ? snap.percent / 100 : 1),
        charging: charging,
        chargingTime: charging && snap.state !== 'full' ? Number.POSITIVE_INFINITY : 0,
        dischargingTime: charging ? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY,
      };
    }

    var state = snapshotToState(initial);

    function dispatch(type) {
      if (target) {
        try { target.dispatchEvent(new Event(type)); } catch (e) { /* noop */ }
      }
      (handlers[type] || []).forEach(function (cb) {
        try { cb.call(manager, { type: type }); } catch (e) { /* noop */ }
      });
      var onProp = 'on' + type;
      if (typeof manager[onProp] === 'function') {
        try { manager[onProp].call(manager, { type: type }); } catch (e) { /* noop */ }
      }
    }

    var manager = {
      get level() { return state.level; },
      get charging() { return state.charging; },
      get chargingTime() { return state.chargingTime; },
      get dischargingTime() { return state.dischargingTime; },
      onchargingchange: null,
      onchargingtimechange: null,
      ondischargingtimechange: null,
      onlevelchange: null,
      addEventListener: function (type, cb) {
        if (target) target.addEventListener(type, cb);
        if (handlers[type]) handlers[type].push(cb);
      },
      removeEventListener: function (type, cb) {
        if (target) target.removeEventListener(type, cb);
        if (handlers[type]) handlers[type] = handlers[type].filter(function (f) { return f !== cb; });
      },
      dispatchEvent: function (evt) {
        if (target) return target.dispatchEvent(evt);
        return true;
      },
    };

    listeners['battery.update'] = listeners['battery.update'] || [];
    listeners['battery.update'].push(function (snap) {
      if (!snap) return;
      var next = snapshotToState(snap);
      if (next.level !== state.level) { state.level = next.level; dispatch('levelchange'); }
      if (next.charging !== state.charging) { state.charging = next.charging; dispatch('chargingchange'); }
      if (next.chargingTime !== state.chargingTime) { state.chargingTime = next.chargingTime; dispatch('chargingtimechange'); }
      if (next.dischargingTime !== state.dischargingTime) { state.dischargingTime = next.dischargingTime; dispatch('dischargingtimechange'); }
    });

    request('battery.subscribe').catch(function () { /* noop */ });

    return manager;
  }

  var batteryManagerPromise = null;
  function getBatteryPolyfill() {
    if (!batteryManagerPromise) {
      batteryManagerPromise = request('battery.get').then(function (snap) {
        return createBatteryManager(snap || { level: 1, state: 'unknown' });
      });
    }
    return batteryManagerPromise;
  }

  try {
    var hasNative = typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function';
    if (!hasNative && typeof navigator !== 'undefined') {
      Object.defineProperty(navigator, 'getBattery', {
        configurable: true,
        writable: true,
        value: getBatteryPolyfill,
      });
    }
  } catch (e) { /* noop */ }

  post({ event: 'bridge.ready', data: { version: 2, batteryPolyfill: true } });
})();
true;
`;
