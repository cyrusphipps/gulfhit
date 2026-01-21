#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

module.exports = function (context) {
    const projectRoot = context.opts.projectRoot;
    const buildExtrasPath = path.join(projectRoot, "build-extras.gradle");

    if (!fs.existsSync(buildExtrasPath)) {
        return;
    }

    const platforms = context.opts.platforms || [];
    if (!platforms.includes("android")) {
        return;
    }

    const androidPlatformRoot = path.join(projectRoot, "platforms", "android");
    if (!fs.existsSync(androidPlatformRoot)) {
        return;
    }

    const targetPath = path.join(androidPlatformRoot, "build-extras.gradle");
    fs.copyFileSync(buildExtrasPath, targetPath);
    console.log(`[cordova] Synced build-extras.gradle to ${targetPath}`);
};
