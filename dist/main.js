"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const github_1 = require("./adapters/github");
const analyzer_1 = require("./analysis/analyzer");
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME;
const PR_NUMBER = process.env.PR_NUMBER;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_EVENT_NAME || !PR_NUMBER || !DEEPSEEK_API_KEY) {
    throw new Error('Missing required environment variables');
}
async function main() {
    console.log('Starting main...');
    const adapter = new github_1.GitHubAdapter({
        token: GITHUB_TOKEN,
        repository: GITHUB_REPOSITORY,
        eventName: GITHUB_EVENT_NAME,
        prNumber: PR_NUMBER,
    });
    const prInfo = await adapter.getEventInfo();
    if (!prInfo) {
        throw new Error('Could not get PR info');
    }
    const files = await adapter.getChangedFiles(prInfo);
    const comments = [];
    for (const file of files) {
        if (!file.filename.match(/\.(ts|tsx|js|jsx)$/))
            continue;
        const fileContent = await adapter.getFileContent(prInfo, file.filename);
        const fileComments = await (0, analyzer_1.analyzeFile)({
            file,
            prInfo,
            fileContent,
            deepseekApiKey: DEEPSEEK_API_KEY,
        });
        comments.push(...fileComments);
    }
    if (comments.length > 0) {
        await adapter.createReview(prInfo, comments);
        console.log('Review created with comments:', comments.length);
    }
    else {
        console.log('No comments to create');
    }
}
main().catch(e => {
    console.error('Error in main:', e);
    process.exit(1);
});
