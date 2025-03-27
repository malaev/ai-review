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
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
const controller_1 = require("./controller");
// Загружаем переменные окружения
dotenv.config();
async function main() {
    // Записываем дату и время запуска для диагностики
    console.log(`=== AI Code Review started at ${new Date().toISOString()} ===`);
    console.log('NODE_ENV:', process.env.NODE_ENV || 'not set');
    try {
        // Выводим версии для диагностики
        console.log(`Node.js version: ${process.version}`);
        console.log(`Platform: ${process.platform}, Architecture: ${process.arch}`);
        // Создаем контроллер используя переменные окружения
        const controller = (0, controller_1.createControllerFromEnv)();
        // Получаем тип события
        let eventType = process.env.GITHUB_EVENT_NAME || process.env.GITLAB_EVENT_TYPE;
        if (!eventType) {
            throw new Error('Missing event type. Set either GITHUB_EVENT_NAME or GITLAB_EVENT_TYPE');
        }
        console.log(`Detected event type: ${eventType}`);
        // Проверяем наличие переменной LAST_ANALYZED_COMMIT
        if (process.env.LAST_ANALYZED_COMMIT) {
            console.log(`LAST_ANALYZED_COMMIT is set to: ${process.env.LAST_ANALYZED_COMMIT}`);
            console.log('Only changes since this commit will be analyzed');
        }
        else {
            console.log('LAST_ANALYZED_COMMIT is not set, analyzing all changes in PR/MR');
        }
        // Данные события зависят от платформы
        let eventData = {};
        // Разбираем данные события из переменных окружения
        if (process.env.GITHUB_EVENT_NAME) {
            console.log('Platform: GitHub');
            // GitHub события
            switch (eventType) {
                case 'pull_request':
                    const PR_NUMBER = process.env.PR_NUMBER;
                    if (!PR_NUMBER) {
                        throw new Error('PR_NUMBER is required for pull_request events');
                    }
                    console.log(`Processing GitHub Pull Request #${PR_NUMBER}`);
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
                    console.log(`Processing GitHub Pull Request Comment #${COMMENT_ID}`);
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
            console.log('Platform: GitLab');
            // GitLab события
            switch (eventType) {
                case 'merge_request':
                    const MR_IID = process.env.GITLAB_MERGE_REQUEST_IID;
                    if (!MR_IID) {
                        throw new Error('GITLAB_MERGE_REQUEST_IID is required for merge_request events');
                    }
                    console.log(`Processing GitLab Merge Request !${MR_IID}`);
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
                    console.log(`Processing GitLab Merge Request Comment: MR !${MR_IID2}, Discussion: ${DISCUSSION_ID}, Note: ${NOTE_ID}`);
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
        console.log('Event data prepared, starting processing...');
        // Засекаем время на выполнение
        const startTime = Date.now();
        // Обрабатываем событие
        await controller.processEvent(eventType, eventData);
        // После успешного выполнения выводим текущий коммит
        if (eventType === 'pull_request' || eventType === 'merge_request') {
            console.log('For future runs, to analyze only new changes, set:');
            console.log('export LAST_ANALYZED_COMMIT=$(git rev-parse HEAD)');
        }
        const elapsedTime = (Date.now() - startTime) / 1000;
        console.log(`Event processing completed in ${elapsedTime.toFixed(2)} seconds`);
        console.log(`=== AI Code Review completed at ${new Date().toISOString()} ===`);
    }
    catch (error) {
        console.error('Error during code review:', error);
        // Выводим трассировку стека для более простой отладки
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
        // Устанавливаем статус выхода, чтобы CI/CD пайплайн знал о неудаче
        process.exit(1);
    }
}
// Регистрируем обработчик необработанных исключений
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});
// Запускаем
main();
