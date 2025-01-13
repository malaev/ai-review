# AI Code Review для React + TypeScript

Автоматический агент для проверки кода в Pull Request для React + TypeScript проектов. Использует DeepSeek AI для анализа кода и оставляет комментарии к проблемным местам.

## Возможности

- 📝 Анализ качества кода
- 🔒 Проверка безопасности
- ⚡ Рекомендации по производительности
- 💬 Интерактивные ответы на вопросы в комментариях

## Как использовать

1. Добавьте секрет `DEEPSEEK_API_KEY` в настройках вашего репозитория (Settings -> Secrets -> Actions)

2. Создайте файл `.github/workflows/code-review.yml`:

```yaml
name: Code Review

on:
  pull_request:
    types: [opened, synchronize]
  pull_request_review_comment:
    types: [created]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    
    steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: AI Code Review
      uses: malaev/ai-review@v0.1.34
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        PR_NUMBER: ${{ github.event.pull_request.number }}
        GITHUB_REPOSITORY: ${{ github.repository }}
        GITHUB_EVENT_NAME: ${{ github.event_name }}
        COMMENT_ID: ${{ github.event.comment.id }}
        REPLY_TO_ID: ${{ github.event.comment.in_reply_to_id }}
      with:
        DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Как это работает

1. При создании или обновлении Pull Request, бот анализирует измененные файлы и оставляет комментарии к проблемным местам в коде.

2. Каждый комментарий содержит:
   - Тип проблемы (Quality 📝, Security 🔒, Performance ⚡)
   - Описание проблемы
   - Инструкции как задать уточняющий вопрос

3. Чтобы задать вопрос по комментарию:
   - Начните ваш вопрос с `@ai` или `/ai`

## Что анализируется

Бот фокусируется на серьезных проблемах:
- Утечки памяти
- Неправильное использование React хуков
- Потенциальные race conditions
- Проблемы безопасности
- Серьезные проблемы производительности
- Логические ошибки в бизнес-логике

Бот игнорирует:
- Стилистические проблемы
- Отсутствие типов там, где они очевидны
- Использование console.log
- Мелкие предупреждения линтера
- Отсутствие документации
- Форматирование кода

## Требования

- GitHub Actions должны быть включены в репозитории
- Необходим API ключ от DeepSeek AI
- Pull Request должен содержать изменения в файлах с расширениями: .ts, .tsx, .js, .jsx

## Лицензия

MIT 