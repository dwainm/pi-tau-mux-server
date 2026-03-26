#!/usr/bin/env node
const path = require('path');
const fs = require('fs');

// Find the src directory relative to this script
const srcDir = path.join(path.dirname(__dirname), 'src');
const serverPath = path.join(srcDir, 'server.js');

require(serverPath);