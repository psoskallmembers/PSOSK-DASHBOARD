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

   *** নিচের APPS_SCRIPT_URL এ তোমার নিজের deployment URL বসাও ***
   (Apps Script এডিটরে: Deploy → Manage deployments → Web app URL)
   ================================================================ */

(function (window) {
  'use strict';

  // 👇👇👇 এখানে তোমার Apps Script Web App URL বসাও 👇👇👇
  var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwwqZEqYx5XmBLCOOacf8v5AydbHkObLgUBGEjA1jXS8d3hH03XKOWuGn2s89lfWyq9/exec';
  // 👆👆👆 শেষে অবশ্যই /exec থাকতে হবে 👆👆👆

  function callServer(fnName, args, onSuccess, onFailure) {
    // Content-Type: text/plain ব্যবহার করা হচ্ছে ইচ্ছাকৃতভাবে —
    // এতে ব্রাউজার এটাকে "simple request" ধরে নেয় এবং CORS preflight
    // (OPTIONS) পাঠায় না, যা Apps Script হ্যান্ডেল করে না।
    fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fnName, args: args })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
        return res.json();
      })
      .then(function (data) {
        if (data && data.ok) {
          if (onSuccess) onSuccess(data.result);
        } else {
          var errMsg = (data && data.error) || 'অজানা সার্ভার ত্রুটি।';
          if (onFailure) onFailure(new Error(errMsg));
          else console.error('[gas-run-shim] Server error (no failure handler set):', errMsg);
        }
      })
      .catch(function (err) {
        if (onFailure) onFailure(err);
        else console.error('[gas-run-shim] Network/parse error (no failure handler set):', err);
      });
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
})(window);