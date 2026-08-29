"use strict";

// Plausible's async loader may arrive before or after this file. Install its
// documented queue/init shim without requiring `unsafe-inline` in the site's
// Content Security Policy.
((window.plausible = window.plausible || function () {
	(plausible.q = plausible.q || []).push(arguments);
}), (plausible.init = plausible.init || function (options) {
	plausible.o = options || {};
}));
plausible.init();
