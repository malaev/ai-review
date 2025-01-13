# AI Code Review

Автоматический агент для проверки кода в Pull Request'ах для React + TypeScript проектов. Использует DeepSeek AI для анализа качества кода, безопасности и оптимизации производительности.

## Использование в вашем репозитории

1. Создайте файл `.github/workflows/code-review.yml` в вашем репозитории со следующим содержимым:

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - '**.ts'
      - '**.tsx'
      - '**.js'
      - '**.jsx'
  issue_comment:
    types: [created]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: malaev/ai-review@v1
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          # github-token предоставляется автоматически
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

2. Добавьте секрет `DEEPSEEK_API_KEY` в настройках вашего репозитория:
   - Перейдите в Settings -> Secrets and variables -> Actions
   - Нажмите "New repository secret"
   - Имя: `DEEPSEEK_API_KEY`
   - Значение: ваш API ключ от DeepSeek

3. Готово! Теперь при создании или обновлении PR бот будет автоматически проводить ревью кода и отвечать на комментарии.

## Как это работает

1. При создании или обновлении PR, который затрагивает TypeScript/JavaScript файлы, запускается GitHub Action
2. Агент получает diff изменений
3. Анализирует код с помощью DeepSeek AI
4. Оставляет комментарий в PR с результатами анализа по трем категориям:
   - Качество кода
   - Безопасность
   - Производительность

## Настройка

Вы можете настроить поведение бота, изменив следующие параметры в вашем workflow:

```yaml
- uses: malaev/ai-review@v1
  with:
    # Обязательные параметры
    deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Для разработчиков

Если вы хотите внести изменения в код ревьюера:

```bash
# Установка зависимостей
npm install

# Сборка проекта
npm run build

# Запуск линтера
npm run lint

# Локальное тестирование
npm run test:local
```

## Требования

- GitHub Actions в репозитории
- API ключ DeepSeek 