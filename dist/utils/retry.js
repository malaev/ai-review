"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.delay = void 0;
exports.withRetry = withRetry;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
exports.delay = delay;
async function withRetry(operation, retries = 3, retryDelay = 1000) {
    try {
        return await operation();
    }
    catch (error) {
        if (retries > 0) {
            await (0, exports.delay)(retryDelay);
            return withRetry(operation, retries - 1, retryDelay);
        }
        throw error;
    }
}
