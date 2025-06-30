import { PlatformAdapter, PullRequestInfo, ReviewComment } from './types';

export class GitLabAdapter implements PlatformAdapter {
  constructor(/* параметры для инициализации GitLab API */) {
    // TODO: инициализация GitLab API клиента
  }

  async getChangedFiles(prInfo: PullRequestInfo): Promise<Array<{ filename: string; patch?: string }>> {
    // TODO: реализовать получение изменённых файлов через GitLab API
    throw new Error('GitLabAdapter.getChangedFiles не реализован');
    // return [];
  }

  async getPRDiff(prInfo: PullRequestInfo): Promise<any> {
    // TODO: реализовать получение diff через GitLab API
    throw new Error('GitLabAdapter.getPRDiff не реализован');
    // return {};
  }

  async createReview(prInfo: PullRequestInfo, comments: ReviewComment[]): Promise<void> {
    // TODO: реализовать создание ревью/комментариев через GitLab API
    throw new Error('GitLabAdapter.createReview не реализован');
  }

  async getFileContent(prInfo: PullRequestInfo, filePath: string): Promise<string> {
    // TODO: реализовать получение содержимого файла через GitLab API
    throw new Error('GitLabAdapter.getFileContent не реализован');
    // return '';
  }

  async getEventInfo(): Promise<PullRequestInfo | null> {
    // TODO: реализовать извлечение информации о Merge Request из переменных окружения GitLab CI
    throw new Error('GitLabAdapter.getEventInfo не реализован');
    // return null;
  }
} 