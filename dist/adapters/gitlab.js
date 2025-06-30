"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitLabAdapter = void 0;
class GitLabAdapter {
    constructor( /* параметры для инициализации GitLab API */) {
        // TODO: инициализация GitLab API клиента
    }
    async getChangedFiles(prInfo) {
        // TODO: реализовать получение изменённых файлов через GitLab API
        throw new Error('GitLabAdapter.getChangedFiles не реализован');
        // return [];
    }
    async getPRDiff(prInfo) {
        // TODO: реализовать получение diff через GitLab API
        throw new Error('GitLabAdapter.getPRDiff не реализован');
        // return {};
    }
    async createReview(prInfo, comments) {
        // TODO: реализовать создание ревью/комментариев через GitLab API
        throw new Error('GitLabAdapter.createReview не реализован');
    }
    async getFileContent(prInfo, filePath) {
        // TODO: реализовать получение содержимого файла через GitLab API
        throw new Error('GitLabAdapter.getFileContent не реализован');
        // return '';
    }
    async getEventInfo() {
        // TODO: реализовать извлечение информации о Merge Request из переменных окружения GitLab CI
        throw new Error('GitLabAdapter.getEventInfo не реализован');
        // return null;
    }
}
exports.GitLabAdapter = GitLabAdapter;
