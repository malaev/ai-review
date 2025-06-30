"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCode = normalizeCode;
function normalizeCode(code) {
    return code.trim().replace(/\s+/g, ' ');
}
