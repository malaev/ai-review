import { GitHubAdapter } from './adapters/github';
import { analyzeFile } from './analysis/analyzer';
import * as dotenv from 'dotenv';

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
  const adapter = new GitHubAdapter({
    token: GITHUB_TOKEN as string,
    repository: GITHUB_REPOSITORY as string,
    eventName: GITHUB_EVENT_NAME as string,
    prNumber: PR_NUMBER as string,
  });

  const prInfo = await adapter.getEventInfo();
  if (!prInfo) {
    throw new Error('Could not get PR info');
  }

  const files = await adapter.getChangedFiles(prInfo);
  const comments: any[] = [];

  for (const file of files) {
    if (!file.filename.match(/\.(ts|tsx|js|jsx)$/)) continue;
    const fileContent = await adapter.getFileContent(prInfo, file.filename);
    const fileComments = await analyzeFile({
      file,
      prInfo,
      fileContent,
      deepseekApiKey: DEEPSEEK_API_KEY as string,
    });
    comments.push(...fileComments);
  }

  if (comments.length > 0) {
    await adapter.createReview(prInfo, comments);
    console.log('Review created with comments:', comments.length);
  } else {
    console.log('No comments to create');
  }
}

main().catch(e => {
  console.error('Error in main:', e);
  process.exit(1);
});