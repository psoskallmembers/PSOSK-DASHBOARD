/* ================================================================
   PSOSK - google.script.run SHIM (for GitHub Pages / any external host)
   ================================================================
   এই ফাইলটা তোমার প্রতিটা HTML পেজে <script src="gas-run-shim.js"></script>
   দিয়ে সবচেয়ে ওপরে (অন্য সব স্ক্রিপ্টের আগে) লোড করো।

   এরপর তোমার পুরনো কোড:
     google.script.run
       .withSuccessHandler(function(result){ ... })
       .withFailureHandler(function(error){ ... })
       .resetPassword({ email: email, code: code, newPassword: newPassword });

   এক অক্ষরও না বদলে আগের মতোই কাজ করবে — শুধু ব্যাকগ্রাউন্ডে এখন এটা
   Apps Script Web App এ fetch() দিয়ে POST পাঠায়।

   ===== Token System (v2) =====
   • loginUser/checkLogin সফল হলে সার্ভার token পাঠায় → সেটা localStorage-এ save হয়
   • পরবর্তী প্রতিটা request-এ সেই token স্বয়ংক্রিয়ভাবে body-তে যোগ হয়
   • Session expired হলে ("Session মেয়াদোত্তীর্ণ") token মুছে যায় ও user কে জানানো হয়
   • logoutUser() কল করলে token সার্ভার + localStorage দুই জায়গা থেকেই মুছে যায়
   ================================================================ */

(function (window) {
  'use strict';

  // 👇👇👇 এখানে তোমার Apps Script Web App URL বসাও 👇👇👇
  var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwwqZEqYx5XmBLCOOacf8v5AydbHkObLgUBGEjA1jXS8d3hH03XKOWuGn2s89lfWyq9/exec';
  // 👆👆👆 শেষে অবশ্যই /exec থাকতে হবে 👆👆👆

  // ===== কনফিগারেশন =====
  var CONFIG = {
    TIMEOUT_MS: 60000,
    DEBUG: false,
    MAX_RETRIES: 0
  };

  // ===== Token storage key =====
  var TOKEN_STORAGE_KEY = 'psosk_disp_token';
  var TOKEN_EXPIRED_EVENT = 'psosk_session_expired';

  // ===== Session-expiry detection (server error message pattern) =====
  var SESSION_EXPIRED_PATTERNS_ = [
    'Session মেয়াদোত্তীর্ণ',
    'আবার লগইন করুন',
    'অবৈধ। অনুগ্রহ করে'
  ];

  // ===== Token helpers =====
  function getToken_() {
    try { return localStorage.getItem(TOKEN_STORAGE_KEY) || ''; }
    catch (e) { return ''; }
  }

  function setToken_(token) {
    try {
      if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
      else localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (e) {}
  }

  function clearToken_() {
    try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch (e) {}
  }

  function isSessionExpiredMsg_(msg) {
    if (!msg) return false;
    msg = String(msg);
    for (var i = 0; i < SESSION_EXPIRED_PATTERNS_.length; i++) {
      if (msg.indexOf(SESSION_EXPIRED_PATTERNS_[i]) !== -1) return true;
    }
    return false;
  }

  function fireSessionExpired_(reason) {
    clearToken_();
    try {
      window.dispatchEvent(new CustomEvent(TOKEN_EXPIRED_EVENT, { detail: { reason: reason || '' } }));
    } catch (e) {
      // পুরনো ব্রাউজারে CustomEvent না থাকলে fallback
      try {
        var evt = document.createEvent('Event');
        evt.initEvent(TOKEN_EXPIRED_EVENT, true, true);
        window.dispatchEvent(evt);
      } catch (e2) {}
    }
    logError_('🔒 Session expired — token cleared. Reason:', reason || '');
  }

  // ===== Public API for pages (login page থেকে কল করার জন্য) =====
  window.PSOSK_getToken = getToken_;
  window.PSOSK_setToken = setToken_;
  window.PSOSK_clearToken = clearToken_;
  window.PSOSK_SESSION_EXPIRED_EVENT = TOKEN_EXPIRED_EVENT;

  // ===== Internal =====
  var REQUEST_ID_COUNTER = 0;

  function logDebug_() {
    if (CONFIG.DEBUG) {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[gas-run-shim]');
      console.log.apply(console, args);
    }
  }

  function logError_() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[gas-run-shim]');
    console.error.apply(console, args);
  }

  // যেসব function login-এর আগেই লাগতে পারে বা logout-এর সময় — এগুলোর জন্য
  // token না থাকলেও কল করা যাবে (যদিও সার্ভার তার নিজের PUBLIC_FUNCTIONS list দেখে
  // চূড়ান্ত সিদ্ধান্ত নেয়)।
  var PUBLIC_FNS_ = {
    'loginUser': 1, 'checkLogin': 1, 'checkEmailExists': 1,
    'signupUserComplete': 1, 'sendSignupVerificationCode': 1,
    'verifySignupCode': 1, 'forgotPassword': 1, 'resetPassword': 1,
    'pingServer': 1, 'getScriptUrl': 1, 'getSiteSettings': 1,
    'getLogoDataUri': 1, 'getCentersList': 1, 'getDesignationsList': 1,
    'getDistrictDivisionMap': 1, 'getDistricts': 1, 'getBloodGroupsList': 1,
    'getServiceCenters': 1, 'getAdminRolesList': 1, 'getCurrentUser': 1,
    'logoutUser': 1
  };

  function doFetch_(fnName, args, signal) {
    // ===== Token সবসময় body-তে পাঠানো হচ্ছে — public fn-এর ক্ষেত্রেও (নাহলে
    // login-এর পর সাথে সাথেই অন্য কলের সময় token নেই বলে সার্ভার reject করে দেবে)।
    // public fn হলে token না থাকলেও সমস্যা নেই — সার্ভার সেটা ignore করবে।
    var body = {
      fn: fnName,
      args: args,
      token: getToken_()
    };

    return fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: signal
    });
  }

  // Response-এ token থাকলে capture করে localStorage-এ save করা হয়
  function captureTokenFromResult_(result) {
    try {
      if (result && typeof result === 'object' && result.token) {
        setToken_(result.token);
        logDebug_('🔑 Token captured & saved to localStorage');
        // Caller কে token না দেওয়ার জন্য result থেকে সরিয়ে দেওয়া হচ্ছে —
        // নাহলে UI-তে অপ্রয়োজনে token চলে যাবে
        try { delete result.token; } catch (e) { /* non-configurable হলে চুপচাপ ignore */ }
      }
    } catch (e) {}
  }

  function callServer(fnName, args, onSuccess, onFailure) {
    var requestId = ++REQUEST_ID_COUNTER;
    var attempt = 0;

    // logoutUser বিশেষ case: কল করার আগেই token ধরে রাখি, response আসার পর মুছে ফেলব
    var isLogout_ = (fnName === 'logoutUser');

    function attemptCall() {
      attempt++;
      logDebug_('▶ Call #' + requestId + ' attempt ' + attempt + ': ' + fnName, args);

      var controller = null;
      var timeoutId = null;
      try {
        controller = new AbortController();
        timeoutId = setTimeout(function () {
          try { controller.abort(); } catch (e) {}
        }, CONFIG.TIMEOUT_MS);
      } catch (e) {
        controller = null;
      }

      doFetch_(fnName, args, controller ? controller.signal : undefined)
        .then(function (res) {
          if (timeoutId) clearTimeout(timeoutId);
          if (!res.ok) {
            throw new Error('HTTP ' + res.status + ' ' + res.statusText);
          }
          return res.json();
        })
        .then(function (data) {
          if (data && data.ok) {
            // ✅ সফল হলে token capture করি (login/checkLogin থেকে আসে)
            captureTokenFromResult_(data.result);

            // logout হলে এখন token মুছে ফেলি (success/failure যাই হোক)
            if (isLogout_) {
              clearToken_();
              logDebug_('🚪 Logout: token cleared from localStorage');
            }

            logDebug_('✅ OK #' + requestId + ': ' + fnName, data.result);
            if (onSuccess) {
              try { onSuccess(data.result); }
              catch (handlerErr) { logError_('Success handler threw:', handlerErr); }
            }
          } else {
            var errMsg = (data && data.error) || 'অজানা সার্ভার ত্রুটি।';

            // 🔒 Session expired হলে token মুছে ফেলি এবং ইভেন্ট ছুড়ি
            if (isSessionExpiredMsg_(errMsg)) {
              fireSessionExpired_(errMsg);
            }

            logError_('❌ Server error #' + requestId + ' (' + fnName + '):', errMsg);
            if (onFailure) {
              try { onFailure(new Error(errMsg)); }
              catch (handlerErr) { logError_('Failure handler threw:', handlerErr); }
            }
          }
        })
        .catch(function (err) {
          if (timeoutId) clearTimeout(timeoutId);

          // ===== Timeout / Abort =====
          var isAbort = (err && (err.name === 'AbortError' || err.code === 20));
          if (isAbort) {
            var tmsg = '⏱️ সার্ভার ' + (CONFIG.TIMEOUT_MS / 1000) + ' সেকেন্ডেও সাড়া দেয়নি (' + fnName + ')';
            logError_('❌ ' + tmsg);
            if (onFailure) {
              try { onFailure(new Error(tmsg)); }
              catch (handlerErr) { logError_('Failure handler threw:', handlerErr); }
            }
            return;
          }

          // ===== Network error (offline / DNS / CORS) =====
          var friendlyMsg = (err && err.message) ? err.message : String(err);
          if (!navigator.onLine) {
            friendlyMsg = '🌐 ইন্টারনেট সংযোগ নেই';
          } else if (friendlyMsg.indexOf('Failed to fetch') !== -1 || friendlyMsg.indexOf('NetworkError') !== -1) {
            friendlyMsg = '🌐 নেটওয়ার্ক সমস্যা অথবা Apps Script deployment URL কাজ করছে না';
          }

          // ===== Retry =====
          if (CONFIG.MAX_RETRIES > 0 && attempt <= CONFIG.MAX_RETRIES) {
            logDebug_('↻ Retrying #' + requestId + ' (attempt ' + (attempt + 1) + ' of ' + (CONFIG.MAX_RETRIES + 1) + ')');
            setTimeout(attemptCall, 500 * attempt);
            return;
          }

          logError_('❌ Network/parse error #' + requestId + ' (' + fnName + '):', err);
          if (onFailure) {
            try { onFailure(new Error(friendlyMsg)); }
            catch (handlerErr) { logError_('Failure handler threw:', handlerErr); }
          }
        });
    }

    attemptCall();
  }

  function makeRunner(successHandler, failureHandler) {
    return new Proxy(function () {}, {
      get: function (target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (fn) { return makeRunner(fn, failureHandler); };
        }
        if (prop === 'withFailureHandler') {
          return function (fn) { return makeRunner(successHandler, fn); };
        }
        if (prop === 'withUserObject') {
          return function () { return makeRunner(successHandler, failureHandler); };
        }
        return function () {
          var args = Array.prototype.slice.call(arguments);
          callServer(prop, args, successHandler, failureHandler);
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};

// GAS-এর ভেতরে চলছে কিনা
var IS_GAS_ = /script\.google\.com|googleusercontent\.com/.test(location.hostname);
window.PSOSK_IS_GAS = IS_GAS_;

// পেজ নেভিগেশন: GAS-এ হলে ?page=..., GitHub-এ হলে আলাদা .html ফাইল
// ধরে নিচ্ছি GitHub-এ পেজগুলোর নাম: index.html, dashboard.html, patients.html, reset.html
var PAGE_MAP_ = {
  login: 'index.html',
  dashboard: 'dashboard.html',
  patients: 'patients.html',
  reset: 'reset.html'
};

     // ===== Page navigation helper =====
  var IS_GAS_ = /script\.google\.com|googleusercontent\.com/.test(location.hostname);
  window.PSOSK_IS_GAS = IS_GAS_;

  // GitHub-এ পেজের ফাইলের নাম (সব ছোট হাতের)
  var PAGE_MAP_ = {
    login: 'index.html',
    dashboard: 'dashboard.html',
    patients: 'patients.html',
    reset: 'reset.html'
  };

  window.PSOSK_pageUrl = function (page, params) {
    var parts = [];
    if (params) {
      for (var k in params) {
        if (params[k] != null && params[k] !== '') {
          parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        }
      }
    }
    var qs = parts.join('&');
    if (IS_GAS_) {
      var q = (page && page !== 'login' ? 'page=' + page : '');
      if (qs) q += (q ? '&' : '') + qs;
      return APPS_SCRIPT_URL + (q ? '?' + q : '');
    }
    return (PAGE_MAP_[page] || 'index.html') + (qs ? '?' + qs : '');
  };

  window.PSOSK_goto = function (page, params) {
    window.top.location.href = window.PSOSK_pageUrl(page, params);
  };

window.PSOSK_goto = function (page, params) {
  var qs = '';
  if (params) {
    var parts = [];
    for (var k in params) {
      if (params[k] != null) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    qs = parts.join('&');
  }
  if (IS_GAS_) {
    window.top.location.href = APPS_SCRIPT_URL + '?page=' + page + (qs ? '&' + qs : '');
  } else {
    window.location.href = (PAGE_MAP_[page] || 'index.html') + (qs ? '?' + qs : '');
  }
};
   
  window.google.script.run = makeRunner(null, null);

  window.google.script.host = window.google.script.host || {
    close: function () { console.log('[gas-run-shim] google.script.host.close() — no-op outside Apps Script.'); },
    setHeight: function () {},
    setWidth: function () {}
  };

  window.gasShimDebug = function (on) {
    CONFIG.DEBUG = !!on;
    console.log('[gas-run-shim] DEBUG =', CONFIG.DEBUG);
  };

  // (Optional) auto-cleanup: পেজ load হওয়ার সময় যদি token থাকে কিন্তু expire হয়ে থাকে,
  // প্রথম API কলেই সার্ভার "Session expired" error দেবে এবং shim token মুছে দেবে।
  logDebug_('✅ gas-run-shim.js loaded — token-aware mode');
})(window);
