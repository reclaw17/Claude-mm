(function () {
  "use strict";
  // The app adds a "mac" class (and room for the window buttons) only when navigator.platform says Mac.
  try {
    Object.defineProperty(navigator, "platform", { get: function () { return "MacIntel"; } });
  } catch (error) {}

  var RESPONSES = /*__RESPONSES__*/{};
  var nextCallbackId = 1;

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: function (callback) {
      var id = nextCallbackId++;
      window["__shot_cb_" + id] = callback;
      return id;
    },
    unregisterCallback: function (id) { delete window["__shot_cb_" + id]; },
    convertFileSrc: function (filePath) { return filePath; },
    invoke: function (cmd) {
      if (Object.prototype.hasOwnProperty.call(RESPONSES, cmd)) {
        return Promise.resolve(JSON.parse(JSON.stringify(RESPONSES[cmd])));
      }
      return Promise.reject(new Error("screenshot mock: no response for " + cmd));
    },
  };

  var addLights = function () {
    var box = document.createElement("div");
    box.id = "shot-lights";
    box.innerHTML = "<i></i><i></i><i></i>";
    document.body.appendChild(box);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addLights);
  else addLights();
})();
