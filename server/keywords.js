/**
 * Модуль для анализа сообщений на соответствие ключевым словам
 */

class KeywordMatcher {
    constructor() {
        // Стоп-слова которые игнорируем при анализе
        this.stopWords = new Set([
            'и', 'в', 'на', 'с', 'по', 'для', 'от', 'за', 'к', 'из',
            'а', 'но', 'или', 'что', 'как', 'это', 'так', 'же',
            'не', 'да', 'нет', 'бы', 'ли', 'то', 'вот', 'ещё',
            'уже', 'тоже', 'только', 'очень', 'может', 'быть'
        ]);
    }

    /**
     * Нормализация текста для сравнения
     */
    normalizeText(text) {
        return text
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[^\wа-яa-z\s]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Проверяет содержит ли текст ключевые слова
     * @param {string} text - текст сообщения
     * @param {Array} keywords - массив ключевых слов/фраз
     * @returns {Object} - результат проверки с деталями
     */
    match(text, keywords) {
        if (!text || !keywords || keywords.length === 0) {
            return { matched: false, matchedKeywords: [] };
        }

        const normalizedText = this.normalizeText(text);
        const matchedKeywords = [];

        for (const keyword of keywords) {
            const normalizedKeyword = this.normalizeText(keyword);
            
            // Проверяем прямое вхождение фразы
            if (normalizedText.includes(normalizedKeyword)) {
                matchedKeywords.push(keyword);
                continue;
            }

            // Проверяем отдельные слова из фразы (если фраза из нескольких слов)
            const keywordParts = normalizedKeyword.split(' ').filter(w => w.length > 2);
            if (keywordParts.length > 1) {
                const matchedParts = keywordParts.filter(part => 
                    normalizedText.includes(part)
                );
                // Если совпало более 60% слов из фразы
                if (matchedParts.length >= Math.ceil(keywordParts.length * 0.6)) {
                    matchedKeywords.push(keyword);
                }
            }
        }

        return {
            matched: matchedKeywords.length > 0,
            matchedKeywords: [...new Set(matchedKeywords)]
        };
    }

    /**
     * Проверяет сообщение на соответствие паттернам поиска
     * Например: "ищу дизайнера" -> проверяет паттерн "ищу + профессия"
     */
    matchPatterns(text, patterns) {
        const normalizedText = this.normalizeText(text);
        const matchedPatterns = [];

        // Паттерны для поиска специалистов
        const searchPatterns = [
            /ищу\s+(\w+)/gi,
            /нужен\s+(\w+)/gi,
            /нужна\s+(\w+)/gi,
            /требуется\s+(\w+)/gi,
            /посоветуйте\s+(\w+)/gi,
            /порекомендуйте\s+(\w+)/gi,
            /подскажите\s+(\w+)/gi,
            /кто\s+знает\s+(\w+)/gi,
            /есть\s+кто[- ]?нибудь\s+(\w+)/gi
        ];

        for (const pattern of searchPatterns) {
            const matches = normalizedText.matchAll(pattern);
            for (const match of matches) {
                if (match[1] && match[1].length > 2) {
                    // Проверяем, есть ли найденное слово в списке искомых паттернов
                    for (const targetPattern of patterns) {
                        const normalizedTarget = this.normalizeText(targetPattern);
                        if (match[1].includes(normalizedTarget) || normalizedTarget.includes(match[1])) {
                            matchedPatterns.push({
                                pattern: match[0],
                                target: targetPattern
                            });
                        }
                    }
                }
            }
        }

        return {
            matched: matchedPatterns.length > 0,
            matchedPatterns
        };
    }

    /**
     * Полная проверка сообщения
     */
    analyze(text, config) {
        const { keywords = [], patterns = [] } = config;
        
        const keywordResult = this.match(text, keywords);
        const patternResult = this.matchPatterns(text, patterns);

        return {
            matched: keywordResult.matched || patternResult.matched,
            matchedKeywords: keywordResult.matchedKeywords,
            matchedPatterns: patternResult.matchedPatterns,
            originalText: text
        };
    }
}

/**
 * Парсит строку с ключевыми словами в массив
 * Поддерживает разделители: запятая, точка с запятой, новая строка
 */
function parseKeywords(keywordsString) {
    if (!keywordsString) return [];
    
    return keywordsString
        .split(/[,;\n]+/)
        .map(k => k.trim())
        .filter(k => k.length > 0);
}

/**
 * Форматирует сообщение для отправки уведомления
 */
function formatNotification(data) {
    const {
        firstName = 'Неизвестно',
        username,
        userId,
        messageText,
        chatTitle,
        chatId,
        messageId,
        matchedKeywords = []
    } = data;

    // Создаем ссылку на сообщение
    // Для публичных групп: https://t.me/username/messageId
    // Для приватных групп: https://t.me/c/chatId/messageId
    let messageLink;
    if (chatId.toString().startsWith('-100')) {
        const cleanChatId = chatId.toString().replace('-100', '');
        messageLink = `https://t.me/c/${cleanChatId}/${messageId}`;
    } else {
        messageLink = `https://t.me/c/${Math.abs(chatId)}/${messageId}`;
    }

    const usernameDisplay = username ? `@${username}` : 'нет';
    const keywordsDisplay = matchedKeywords.length > 0 
        ? `\n🔑 Ключевые слова: ${matchedKeywords.join(', ')}`
        : '';

    return `🎯 *Найдено совпадение!*
${keywordsDisplay}

👤 *${escapeMarkdown(firstName)}*
├ Username: ${usernameDisplay}
├ User ID: \`${userId}\`

💬 *Сообщение:*
"${escapeMarkdown(truncateText(messageText, 500))}"

📍 *Чат:* [${escapeMarkdown(chatTitle)}](${messageLink})`;
}

/**
 * Экранирование специальных символов Markdown
 */
function escapeMarkdown(text) {
    if (!text) return '';
    return text
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/`/g, '\\`');
}

/**
 * Обрезка текста с многоточием
 */
function truncateText(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
}

module.exports = {
    KeywordMatcher,
    parseKeywords,
    formatNotification,
    escapeMarkdown,
    truncateText
};
