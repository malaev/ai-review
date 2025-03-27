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
const dotenv = __importStar(require("dotenv"));
const controller_1 = require("./controller");
// Загружаем переменные окружения
dotenv.config();
async function main() {
    try {
        // Создаем контроллер используя переменные окружения
        const controller = (0, controller_1.createControllerFromEnv)();
        // Получаем тип события
        let eventType = process.env.GITHUB_EVENT_NAME || process.env.GITLAB_EVENT_TYPE;
        if (!eventType) {
            throw new Error('Missing event type. Set either GITHUB_EVENT_NAME or GITLAB_EVENT_TYPE');
        }
        // Данные события зависят от платформы
        let eventData = {};
        // Разбираем данные события из переменных окружения
        if (process.env.GITHUB_EVENT_NAME) {
            // GitHub события
            switch (eventType) {
                case 'pull_request':
                    const PR_NUMBER = process.env.PR_NUMBER;
                    if (!PR_NUMBER) {
                        throw new Error('PR_NUMBER is required for pull_request events');
                    }
                    eventData = {
                        pull_request: {
                            number: Number(PR_NUMBER)
                        }
                    };
                    break;
                case 'pull_request_review_comment':
                    const COMMENT_ID = process.env.COMMENT_ID;
                    if (!COMMENT_ID) {
                        throw new Error('COMMENT_ID is required for pull_request_review_comment events');
                    }
                    eventData = {
                        comment: {
                            id: Number(COMMENT_ID)
                        }
                    };
                    break;
                default:
                    console.log(`Ignoring event type: ${eventType}`);
                    return;
            }
        }
        else if (process.env.GITLAB_EVENT_TYPE) {
            // GitLab события
            switch (eventType) {
                case 'merge_request':
                    const MR_IID = process.env.GITLAB_MERGE_REQUEST_IID;
                    if (!MR_IID) {
                        throw new Error('GITLAB_MERGE_REQUEST_IID is required for merge_request events');
                    }
                    eventData = {
                        object_attributes: {
                            iid: MR_IID
                        }
                    };
                    break;
                case 'note':
                    const MR_IID2 = process.env.GITLAB_MERGE_REQUEST_IID;
                    const DISCUSSION_ID = process.env.GITLAB_DISCUSSION_ID;
                    const NOTE_ID = process.env.GITLAB_NOTE_ID;
                    if (!MR_IID2 || !DISCUSSION_ID || !NOTE_ID) {
                        throw new Error('GITLAB_MERGE_REQUEST_IID, GITLAB_DISCUSSION_ID and GITLAB_NOTE_ID are required for note events');
                    }
                    eventData = {
                        merge_request: {
                            iid: MR_IID2
                        },
                        object_attributes: {
                            noteable_type: 'MergeRequest',
                            discussion_id: DISCUSSION_ID,
                            id: NOTE_ID
                        }
                    };
                    break;
                default:
                    console.log(`Ignoring event type: ${eventType}`);
                    return;
            }
        }
        // Обрабатываем событие
        await controller.processEvent(eventType, eventData);
    }
    catch (error) {
        console.error('Error during code review:', error);
        process.exit(1);
    }
}
main();
