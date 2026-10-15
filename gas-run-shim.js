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
   ================================================================ */

(function (window) {
  'use strict';

  // 👇👇👇 এখানে তোমার Apps Script Web App URL বসাও 👇👇👇
  var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwwqZEqYx5XmBLCOOacf8v5AydbHkObLgUBGEjA1jXS8d3hH03XKOWuGn2s89lfWyq9/exec';
  // 👆👆👆 শেষে অবশ্যই /exec থাকতে হবে 👆👆👆

  // ===== কনফিগারেশন =====
  var CONFIG = {
    TIMEOUT_MS: 60000,        // ৬০ সেকেন্ড পর টাইমআউট
    DEBUG: false,             // true করলে প্রতিটা call console-এ দেখাবে
    MAX_RETRIES: 0            // 0 = কোনো retry নেই; 1+ দিলে network error-এ আবার চেষ্টা করবে
  };

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

  function doFetch_(fnName, args, signal) {
    return fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fnName, args: args }),
      signal: signal
    });
  }

  function callServer(fnName, args, onSuccess, onFailure) {
    var requestId = ++REQUEST_ID_COUNTER;
    var attempt = 0;

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
        // কিছু পুরনো ব্রাউজারে AbortController নেই — সেক্ষেত্রে timeout কাজ করবে না
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
            logDebug_('✅ OK #' + requestId + ': ' + fnName, data.result);
            if (onSuccess) {
              try { onSuccess(data.result); }
              catch (handlerErr) { logError_('Success handler threw:', handlerErr); }
            }
          } else {
            var errMsg = (data && data.error) || 'অজানা সার্ভার ত্রুটি।';
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

          // ===== Retry করব কি না =====
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

  // Chainable builder — .withSuccessHandler().withFailureHandler().anyFunctionName(args)
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
          // google.script.run এর এই ফিচারটা এখানে ব্যবহার হয় না বলে ধরে নেওয়া হচ্ছে;
          // দরকার হলে জানিও, যোগ করে দেওয়া যাবে।
          return function () { return makeRunner(successHandler, failureHandler); };
        }
        // অন্য যেকোনো নাম = আসল ফাংশন কল, যেমন .resetPassword(...)
        return function () {
          var args = Array.prototype.slice.call(arguments);
          callServer(prop, args, successHandler, failureHandler);
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);

  // google.script.host.close() ইত্যাদি কোথাও ব্যবহার হলে যেন error না দেয়
  window.google.script.host = window.google.script.host || {
    close: function () { console.log('[gas-run-shim] google.script.host.close() — no-op outside Apps Script.'); },
    setHeight: function () {},
    setWidth: function () {}
  };

  // ===== ডিবাগ টগল (ব্রাউজারে console-এ: gasShimDebug(true)) =====
  window.gasShimDebug = function (on) {
    CONFIG.DEBUG = !!on;
    console.log('[gas-run-shim] DEBUG =', CONFIG.DEBUG);
  };
})(window);
