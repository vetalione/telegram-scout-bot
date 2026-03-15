/**
 * Улучшенный модуль для анализа сообщений на соответствие ключевым словам
 * Включает: fuzzy matching, стемминг, синонимы, N-граммы
 */

class KeywordMatcher {
    constructor() {
        // Стоп-слова которые игнорируем при анализе
        this.stopWords = new Set([
            'и', 'в', 'на', 'с', 'по', 'для', 'от', 'за', 'к', 'из',
            'а', 'но', 'или', 'что', 'как', 'это', 'так', 'же',
            'не', 'да', 'нет', 'бы', 'ли', 'то', 'вот', 'ещё',
            'уже', 'тоже', 'только', 'очень', 'может', 'быть',
            'привет', 'здравствуйте', 'спасибо', 'пожалуйста'
        ]);

        // Словарь синонимов (все формы приводим к базовому слову)
        this.synonyms = {
            // Разработчики
            'программист': ['разработчик', 'девелопер', 'developer', 'кодер', 'программер', 'прогер', 'вайбкодер'],
            'разработчик': ['программист', 'девелопер', 'developer', 'кодер', 'программер', 'прогер', 'вайбкодер'],
            'фронтенд': ['frontend', 'фронт', 'верстальщик', 'react', 'vue', 'angular'],
            'бэкенд': ['backend', 'бэк', 'серверный'],
            'фулстек': ['fullstack', 'full-stack', 'фуллстек'],
            
            // Дизайнеры
            'дизайнер': ['designer', 'дизайн', 'ui', 'ux', 'уидизайнер', 'юидизайнер'],
            'графический': ['graphic', 'графика'],
            
            // Действия поиска
            'ищу': ['нужен', 'нужна', 'нужно', 'требуется', 'looking'],
            'посоветуйте': ['порекомендуйте', 'подскажите', 'recommend', 'посоветовать'],
            
            // Маркетинг
            'маркетолог': ['marketer', 'маркетинг', 'smm', 'смм', 'таргетолог'],
            
            // Менеджмент
            'менеджер': ['manager', 'pm', 'пм', 'проджект'],
            
            // Ведущие мероприятий
            'ведущий': ['тамада', 'конферансье', 'церемониймейстер', 'шоумен', 'showman', 'mc', 'мс', 'модератор'],
            'тамада': ['ведущий', 'конферансье', 'церемониймейстер', 'шоумен'],
            
            // Вокал и пение
            'вокал': ['пение', 'вокальный', 'vocal', 'singing', 'голос', 'петь'],
            'вокалист': ['певец', 'певица', 'singer', 'исполнитель'],
            'преподаватель': ['учитель', 'педагог', 'тренер', 'репетитор', 'coach', 'наставник', 'инструктор'],
        };

        // Окончания для стемминга (русский язык)
        this.suffixes = [
            'ами', 'ями', 'ому', 'ему', 'ого', 'его', 'ить', 'ать', 'еть',
            'ов', 'ев', 'ей', 'ий', 'ый', 'ой', 'ая', 'яя', 'ое', 'ее',
            'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'им', 'ым',
            'а', 'я', 'о', 'е', 'и', 'ы', 'у', 'ю'
        ].sort((a, b) => b.length - a.length); // Сначала длинные
    }

    /**
     * Простой стемминг - отрезаем окончания
     */
    stem(word) {
        if (word.length < 4) return word;
        
        for (const suffix of this.suffixes) {
            if (word.endsWith(suffix) && word.length - suffix.length >= 2) {
                return word.slice(0, -suffix.length);
            }
        }
        return word;
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
     * Расстояние Левенштейна для fuzzy matching
     */
    levenshteinDistance(str1, str2) {
        const m = str1.length;
        const n = str2.length;
        const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (str1[i - 1] === str2[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1];
                } else {
                    dp[i][j] = 1 + Math.min(
                        dp[i - 1][j],     // удаление
                        dp[i][j - 1],     // вставка
                        dp[i - 1][j - 1]  // замена
                    );
                }
            }
        }
        return dp[m][n];
    }

    /**
     * Fuzzy matching - проверяет похожесть слов
     * Возвращает true если слова похожи (с учетом опечаток)
     */
    fuzzyMatch(word1, word2, threshold = 0.75) {
        const w1 = this.normalizeText(word1);
        const w2 = this.normalizeText(word2);
        
        // Точное совпадение
        if (w1 === w2) return true;
        
        // Одно слово содержит другое
        if (w1.includes(w2) || w2.includes(w1)) return true;
        
        // Проверяем стеммы
        const stem1 = this.stem(w1);
        const stem2 = this.stem(w2);
        if (stem1 === stem2) return true;
        if (stem1.includes(stem2) || stem2.includes(stem1)) return true;
        
        // Расстояние Левенштейна
        const maxLen = Math.max(w1.length, w2.length);
        if (maxLen < 3) return w1 === w2;
        
        const distance = this.levenshteinDistance(w1, w2);
        const similarity = 1 - (distance / maxLen);
        
        return similarity >= threshold;
    }

    /**
     * Получить все синонимы для слова
     */
    getSynonyms(word) {
        const normalized = this.normalizeText(word);
        const stemmed = this.stem(normalized);
        const synonyms = new Set([normalized, stemmed]);
        
        // Ищем в словаре синонимов
        for (const [key, values] of Object.entries(this.synonyms)) {
            const keyNorm = this.normalizeText(key);
            const keyStem = this.stem(keyNorm);
            
            // Если слово совпадает с ключом или его стеммом
            if (this.fuzzyMatch(normalized, keyNorm) || this.fuzzyMatch(stemmed, keyStem)) {
                synonyms.add(keyNorm);
                synonyms.add(keyStem);
                for (const syn of values) {
                    synonyms.add(this.normalizeText(syn));
                    synonyms.add(this.stem(this.normalizeText(syn)));
                }
            }
            
            // Если слово есть в значениях
            for (const val of values) {
                const valNorm = this.normalizeText(val);
                const valStem = this.stem(valNorm);
                if (this.fuzzyMatch(normalized, valNorm) || this.fuzzyMatch(stemmed, valStem)) {
                    synonyms.add(keyNorm);
                    synonyms.add(keyStem);
                    for (const syn of values) {
                        synonyms.add(this.normalizeText(syn));
                        synonyms.add(this.stem(this.normalizeText(syn)));
                    }
                }
            }
        }
        
        return [...synonyms];
    }

    /**
     * Генерация N-грамм для текста
     */
    getNgrams(text, n = 2) {
        const normalized = this.normalizeText(text);
        const words = normalized.split(' ').filter(w => w.length > 1);
        const ngrams = [];
        
        for (let i = 0; i <= words.length - n; i++) {
            ngrams.push(words.slice(i, i + n).join(' '));
        }
        
        return ngrams;
    }

    /**
     * Проверяет режим ключевого слова:
     * - "фраза" → точное вхождение (isExact)
     * - [фраза] → все слова должны быть (isAllRequired)
     * - фраза → любое слово (обычный режим)
     */
    parseKeywordMode(keyword) {
        const trimmed = keyword.trim();
        
        // Проверяем на квадратные скобки [все слова обязательны]
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            return {
                isExact: false,
                isAllRequired: true,
                cleanKeyword: trimmed.slice(1, -1)
            };
        }
        
        // Проверяем на кавычки (разные виды: "", «», '')
        if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
            (trimmed.startsWith('«') && trimmed.endsWith('»')) ||
            (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
            return {
                isExact: true,
                isAllRequired: false,
                cleanKeyword: trimmed.slice(1, -1)
            };
        }
        
        return {
            isExact: false,
            isAllRequired: false,
            cleanKeyword: trimmed
        };
    }

    /**
     * Проверяет, найдено ли слово в тексте (через stem, synonym или fuzzy)
     * Возвращает { found: boolean, matchType: string, matchedWord: string }
     */
    findWordInText(word, textWords, textStems) {
        const wordNorm = this.normalizeText(word);
        const wordStem = this.stem(wordNorm);
        
        // 1. Точное совпадение слова
        const exactIndex = textWords.findIndex(tw => tw === wordNorm);
        if (exactIndex !== -1) {
            return { found: true, matchType: 'exact', matchedWord: textWords[exactIndex] };
        }
        
        // 1.5. Для коротких слов (3-4 символа) проверяем префикс
        // Это позволяет KOL находить KOLs, API находить APIs и т.д.
        if (wordNorm.length >= 3 && wordNorm.length <= 4) {
            const prefixIndex = textWords.findIndex(tw => 
                tw.startsWith(wordNorm) && tw.length <= wordNorm.length + 2
            );
            if (prefixIndex !== -1) {
                return { found: true, matchType: 'prefix', matchedWord: textWords[prefixIndex] };
            }
        }
        
        // 2. Совпадение по стемму
        if (wordStem.length >= 4) {
            const stemIndex = textStems.findIndex(ts => ts === wordStem);
            if (stemIndex !== -1) {
                return { found: true, matchType: 'stem', matchedWord: textWords[stemIndex] };
            }
        }
        
        // 3. Совпадение по синонимам
        if (wordNorm.length >= 4) {
            const synonyms = this.getSynonyms(wordNorm);
            for (const syn of synonyms) {
                if (syn.length < 4) continue;
                const synStem = this.stem(syn);
                if (synStem.length < 4) continue;
                
                const synIndex = textStems.findIndex(ts => ts === synStem);
                if (synIndex !== -1) {
                    return { found: true, matchType: 'synonym', matchedWord: textWords[synIndex] + ' → ' + syn };
                }
            }
        }
        
        // 4. Fuzzy matching (только для длинных слов)
        if (wordNorm.length >= 6) {
            for (let i = 0; i < textWords.length; i++) {
                if (textWords[i].length >= 6 && this.fuzzyMatch(textWords[i], wordNorm, 0.8)) {
                    return { found: true, matchType: 'fuzzy', matchedWord: textWords[i] + ' ≈ ' + wordNorm };
                }
            }
        }
        
        return { found: false, matchType: '', matchedWord: '' };
    }

    /**
     * Основной метод проверки - улучшенный
     */
    match(text, keywords) {
        if (!text || !keywords || keywords.length === 0) {
            return { matched: false, matchedKeywords: [], matchDetails: [] };
        }

        const normalizedText = this.normalizeText(text);
        const textWords = normalizedText.split(' ').filter(w => w.length > 1 && !this.stopWords.has(w));
        const textStems = textWords.map(w => this.stem(w));
        const matchedKeywords = [];
        const matchDetails = [];

        for (const keyword of keywords) {
            // Парсим режим ключевого слова (точный, все обязательны, или умный)
            const { isExact, isAllRequired, cleanKeyword } = this.parseKeywordMode(keyword);
            const keywordParts = this.normalizeText(cleanKeyword).split(' ').filter(w => w.length > 1);
            let matched = false;
            let matchType = '';
            let matchedWord = ''; // Какое слово из текста сматчилось

            // Для точных фраз (в кавычках) - только exact match
            if (isExact) {
                if (normalizedText.includes(this.normalizeText(cleanKeyword))) {
                    matched = true;
                    matchType = 'exact (strict)';
                    matchedWord = cleanKeyword;
                }
                // Для точных фраз не используем другие методы!
                if (matched) {
                    matchedKeywords.push(keyword);
                    matchDetails.push({ keyword, matchType, matchedWord });
                }
                continue;
            }

            // Для режима [все слова обязательны] - каждое слово должно быть найдено
            if (isAllRequired && keywordParts.length > 1) {
                const foundWords = [];
                const matchTypes = [];
                let allFound = true;
                
                for (const part of keywordParts) {
                    const result = this.findWordInText(part, textWords, textStems);
                    if (result.found) {
                        foundWords.push(result.matchedWord);
                        matchTypes.push(result.matchType);
                    } else {
                        allFound = false;
                        break;
                    }
                }
                
                if (allFound) {
                    matched = true;
                    matchType = 'all-required (' + [...new Set(matchTypes)].join('+') + ')';
                    matchedWord = foundWords.join(' + ');
                    matchedKeywords.push(keyword);
                    matchDetails.push({ keyword, matchType, matchedWord });
                }
                continue;
            }

            // 1. Прямое вхождение фразы
            if (normalizedText.includes(this.normalizeText(cleanKeyword))) {
                matched = true;
                matchType = 'exact';
                matchedWord = keyword;
            }

            // 2. Проверка по стеммам (только точное совпадение, без includes)
            if (!matched) {
                for (const part of keywordParts) {
                    if (part.length < 4) continue; // Пропускаем короткие слова
                    const partStem = this.stem(part);
                    if (partStem.length < 4) continue; // Пропускаем короткие стеммы
                    // Только точное совпадение стеммов
                    const stemIndex = textStems.findIndex(ts => ts === partStem);
                    if (stemIndex !== -1) {
                        matched = true;
                        matchType = 'stem';
                        matchedWord = textWords[stemIndex] + ' (stem: ' + partStem + ')';
                        break;
                    }
                }
            }

            // 3. Проверка по синонимам (только точное совпадение стеммов)
            if (!matched) {
                for (const part of keywordParts) {
                    if (part.length < 4) continue; // Пропускаем короткие слова
                    const synonyms = this.getSynonyms(part);
                    for (const syn of synonyms) {
                        if (syn.length < 4) continue; // Пропускаем короткие синонимы
                        const synStem = this.stem(syn);
                        if (synStem.length < 4) continue;
                        // Только точное совпадение стеммов синонимов
                        const stemIndex = textStems.findIndex(ts => ts === synStem);
                        if (stemIndex !== -1) {
                            matched = true;
                            matchType = 'synonym';
                            matchedWord = textWords[stemIndex] + ' → ' + syn + ' (synonym of ' + part + ')';
                            break;
                        }
                    }
                    if (matched) break;
                }
            }

            // 4. Fuzzy matching только для длинных слов (≥6 символов), порог 0.8
            if (!matched) {
                for (const part of keywordParts) {
                    if (part.length < 6) continue; // Fuzzy только для длинных слов
                    for (const textWord of textWords) {
                        if (textWord.length < 6) continue; // И длинных слов в тексте
                        if (this.fuzzyMatch(textWord, part, 0.8)) {
                            matched = true;
                            matchType = 'fuzzy';
                            matchedWord = textWord + ' ≈ ' + part;
                            break;
                        }
                    }
                    if (matched) break;
                }
            }

            // 5. N-граммы для многословных ключей (порог 0.75)
            if (!matched && keywordParts.length > 1) {
                const textNgrams = this.getNgrams(normalizedText, keywordParts.length);
                const keywordNgram = keywordParts.join(' ');
                
                for (const ngram of textNgrams) {
                    if (this.fuzzyMatch(ngram, keywordNgram, 0.75)) {
                        matched = true;
                        matchType = 'ngram';
                        matchedWord = ngram + ' ≈ ' + keywordNgram;
                        break;
                    }
                }
            }

            if (matched) {
                matchedKeywords.push(keyword);
                matchDetails.push({ keyword, matchType, matchedWord });
            }
        }

        return {
            matched: matchedKeywords.length > 0,
            matchedKeywords: [...new Set(matchedKeywords)],
            matchDetails
        };
    }

    /**
     * Проверяет сообщение на соответствие паттернам поиска
     */
    matchPatterns(text, patterns) {
        const normalizedText = this.normalizeText(text);
        const matchedPatterns = [];

        // Паттерны для поиска специалистов (с fuzzy)
        const searchPatterns = [
            /ищу\s+(\S+)/gi,
            /нужен\s+(\S+)/gi,
            /нужна\s+(\S+)/gi,
            /нужно\s+(\S+)/gi,
            /требуется\s+(\S+)/gi,
            /посоветуйте\s+(\S+)/gi,
            /порекомендуйте\s+(\S+)/gi,
            /подскажите\s+(\S+)/gi,
            /кто\s+знает\s+(\S+)/gi,
            /есть\s+(\S+)\s*\?/gi
        ];

        for (const pattern of searchPatterns) {
            const matches = normalizedText.matchAll(pattern);
            for (const match of matches) {
                if (match[1] && match[1].length > 2) {
                    for (const targetPattern of patterns) {
                        const normalizedTarget = this.normalizeText(targetPattern);
                        // Используем fuzzy matching
                        if (this.fuzzyMatch(match[1], normalizedTarget, 0.6)) {
                            matchedPatterns.push({
                                pattern: match[0],
                                target: targetPattern,
                                found: match[1]
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
            matchDetails: keywordResult.matchDetails,
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
        matchedKeywords = [],
        matchDetails = []
    } = data;

    // Создаем ссылку на сообщение
    let messageLink;
    if (chatId.toString().startsWith('-100')) {
        const cleanChatId = chatId.toString().replace('-100', '');
        messageLink = `https://t.me/c/${cleanChatId}/${messageId}`;
    } else {
        messageLink = `https://t.me/c/${Math.abs(chatId)}/${messageId}`;
    }

    const usernameDisplay = username ? `@${username}` : 'нет';
    
    // Показываем детали совпадения с типом матча и найденным словом
    let keywordsDisplay = '';
    if (matchedKeywords.length > 0) {
        if (matchDetails && matchDetails.length > 0) {
            const detailsStr = matchDetails.map(d => {
                let detail = `"${d.keyword}" (${d.matchType})`;
                if (d.matchedWord) {
                    detail += `\n   └ Найдено: "${d.matchedWord}"`;
                }
                return detail;
            }).join('\n');
            keywordsDisplay = `\n🔑 *Совпадения:*\n${detailsStr}`;
        } else {
            keywordsDisplay = `\n🔑 *Ключевые слова:* ${matchedKeywords.join(', ')}`;
        }
    }

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
