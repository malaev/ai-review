import * as dotenv from 'dotenv';
import { createControllerFromEnv } from './controller';

// Загружаем переменные окружения
dotenv.config();

async function main() {
  try {
    // Создаем контроллер используя переменные окружения
    const controller = createControllerFromEnv();

    // Получаем тип события
    let eventType = process.env.GITHUB_EVENT_NAME || process.env.GITLAB_EVENT_TYPE;

    if (!eventType) {
      throw new Error('Missing event type. Set either GITHUB_EVENT_NAME or GITLAB_EVENT_TYPE');
    }

    // Данные события зависят от платформы
    let eventData: any = {};

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
    } else if (process.env.GITLAB_EVENT_TYPE) {
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

  } catch (error) {
    console.error('Error during code review:', error);
    process.exit(1);
  }
}

main(); 