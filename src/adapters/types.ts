// Общие типы для анализа и комментариев

export interface PullRequestInfo {
  owner: string;
  repo: string;
  pull_number: number;
}

export interface CodeAnalysis {
  quality: string[];
  security: string[];
  performance: string[];
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface AnalysisIssue {
  line: number;
  type: 'quality' | 'security' | 'performance';
  description: string;
}

export interface AnalysisIssueWithCode extends AnalysisIssue {
  code: string;
}

export interface AnalysisResponse {
  issues: AnalysisIssue[];
}

export interface AnalysisResponseWithCode {
  issues: AnalysisIssueWithCode[];
}

// Интерфейс платформенного адаптера
export interface PlatformAdapter {
  getChangedFiles(prInfo: PullRequestInfo): Promise<Array<{ filename: string; patch?: string }>>;
  getPRDiff(prInfo: PullRequestInfo): Promise<any>;
  createReview(prInfo: PullRequestInfo, comments: ReviewComment[]): Promise<void>;
  getFileContent(prInfo: PullRequestInfo, filePath: string): Promise<string>;
  getEventInfo(): Promise<PullRequestInfo | null>;
  // ... другие методы по необходимости
} 