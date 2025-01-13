import 'dotenv/config';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Эмуляция переменных окружения GitHub Actions
process.env.GITHUB_REPOSITORY = process.env.TEST_REPOSITORY || 'owner/repo';
process.env.GITHUB_EVENT_NAME = 'pull_request';
process.env.PR_NUMBER = process.env.TEST_PR_NUMBER || '1';

// Функция для создания тестового PR
async function createTestPR() {
  // Создаем тестовую ветку
  execSync('git checkout -b test-pr-branch');

  // Создаем тестовый файл с изменениями
  const testFile = 'src/test-component.tsx';
  const testCode = `
import React, { useState, useEffect } from 'react';

interface Props {
  name: string;
}

export const TestComponent: React.FC<Props> = ({ name }) => {
  const [count, setCount] = useState(0);
  
  useEffect(() => {
    // Намеренная ошибка для тестирования
    const timer = setInterval(() => {
      setCount(c => c + 1);
    }, 1000);
  }, []); // Отсутствует очистка эффекта

  const handleClick = () => {
    // Тестовая уязвимость
    eval(name);
  };

  return (
    <div onClick={handleClick}>
      {name}: {count}
    </div>
  );
};
`;

  fs.writeFileSync(testFile, testCode);

  // Коммитим изменения
  execSync('git add .');
  execSync('git commit -m "test: Add test component for review"');

  // Пушим ветку (если нужно)
  if (process.env.PUSH_BRANCH === 'true') {
    execSync('git push origin test-pr-branch');
  }
}

// Функция для эмуляции комментария
async function emulateComment() {
  process.env.GITHUB_EVENT_NAME = 'issue_comment';
  process.env.COMMENT_ID = '12345';
  process.env.REPLY_TO_ID = '12344';

  const testComment = {
    body: 'Почему здесь нет cleanup в useEffect?',
    user: {
      login: 'test-user'
    },
    issue_url: `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues/${process.env.PR_NUMBER}`
  };

  // Создаем временный файл с событием
  const eventPath = path.join(__dirname, 'test-event.json');
  fs.writeFileSync(eventPath, JSON.stringify({
    action: 'created',
    comment: testComment,
    issue: {
      pull_request: {}
    }
  }));

  process.env.GITHUB_EVENT_PATH = eventPath;
}

async function main() {
  try {
    // Создаем тестовый PR
    await createTestPR();
    console.log('✅ Тестовый PR создан');

    // Запускаем ревью кода
    console.log('🔍 Запускаем ревью кода...');
    execSync('npm run review', { stdio: 'inherit' });

    // Эмулируем комментарий и ответ на него
    console.log('💬 Эмулируем комментарий...');
    await emulateComment();
    execSync('npm run review', { stdio: 'inherit' });

    // Очистка
    execSync('git checkout main');
    execSync('git branch -D test-pr-branch');
    console.log('🧹 Тестовое окружение очищено');
  } catch (error) {
    console.error('❌ Ошибка при тестировании:', error);
    process.exit(1);
  }
}

main(); 