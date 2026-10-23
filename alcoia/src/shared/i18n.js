/* i18n.js — the words on alcoia's own cards, in the language of the page.
 *
 * Generated questions and explanations already come back in the language of the
 * passage (the server follows the passage). This file covers the fixed words
 * around them: badges, buttons, the confidence step, the self-report card, the
 * snooze menu, the "why now" line and the result lines.
 *
 * The language is the page's, not the browser's: document.documentElement.lang
 * first, then the script check in segmentation.js's detectLanguage() (which
 * already does that in that order). A page in a language this table does not
 * cover gets English.
 *
 * English lives in the EN table below and doubles as the lookup key for text
 * that other modules still build in English (evidence lines, badges):
 * tr('quick check', 'fr') finds it by its English wording. Anything not in the
 * table is returned unchanged, so a missing entry shows English, never a blank.
 *
 * These translations have not been reviewed by native speakers.
 */

import { detectLanguage } from '../content/signals/segmentation.js';

export const UI_LANGS = Object.freeze(['en', 'fr', 'es', 'de', 'pt', 'it', 'nl', 'zh', 'ja', 'ko', 'ar', 'ru']);
const RTL = new Set(['ar']);

/* key: [en, fr, es, de, pt, it, nl, zh, ja, ko, ar, ru] */
const ORDER = UI_LANGS;
const ROWS = {
  'badge.quickCheck': ['quick check', 'vérification rapide', 'comprobación rápida', 'kurze Prüfung', 'verificação rápida', 'controllo rapido', 'snelle check', '快速检查', 'クイックチェック', '간단 확인', 'فحص سريع', 'быстрая проверка'],
  'badge.fromEarlier': ['from earlier', 'vu plus tôt', 'de antes', 'von vorhin', 'de antes', 'di prima', 'van eerder', '之前学过的', '前に出てきた内容', '앞에서 본 내용', 'من قبل', 'из пройденного'],
  'badge.closerLook': ['a closer look', 'un regard plus attentif', 'una mirada más de cerca', 'genauer hingeschaut', 'um olhar mais atento', 'uno sguardo più da vicino', 'even beter kijken', '再看仔细些', 'もう少し詳しく', '자세히 보기', 'نظرة أقرب', 'присмотримся'],
  'badge.clearingUp': ['clearing this up', 'pour y voir clair', 'para aclararlo', 'zur Klärung', 'para esclarecer', 'per chiarire', 'om dit op te helderen', '澄清一下', '整理しましょう', '정리해 보기', 'لتوضيح ذلك', 'проясним'],
  'badge.connect': ['how the ideas connect', 'le lien entre les idées', 'cómo se conectan las ideas', 'wie die Ideen zusammenhängen', 'como as ideias se ligam', 'come si collegano le idee', 'hoe de ideeën samenhangen', '这些想法如何联系', '考えのつながり', '아이디어의 연결', 'كيف ترتبط الأفكار', 'как связаны идеи'],
  'badge.selected': ['selected text', 'texte sélectionné', 'texto seleccionado', 'markierter Text', 'texto selecionado', 'testo selezionato', 'geselecteerde tekst', '所选文字', '選択したテキスト', '선택한 텍스트', 'النص المحدد', 'выделенный текст'],
  'card.typeAnswer': ['Type your answer…', 'Écrivez votre réponse…', 'Escribe tu respuesta…', 'Antwort eingeben …', 'Escreva a sua resposta…', 'Scrivi la tua risposta…', 'Typ je antwoord…', '输入你的答案…', '答えを入力…', '답을 입력하세요…', 'اكتب إجابتك…', 'Введите ответ…'],
  'card.skip': ['Skip this', 'Passer', 'Omitir', 'Überspringen', 'Saltar', 'Salta', 'Overslaan', '跳过', 'スキップ', '건너뛰기', 'تخطَّ هذا', 'Пропустить'],
  'card.snooze': ['Snooze reminders', 'Mettre les rappels en pause', 'Pausar recordatorios', 'Erinnerungen pausieren', 'Pausar lembretes', 'Sospendi i promemoria', 'Herinneringen pauzeren', '暂停提醒', 'リマインダーを一時停止', '알림 일시 중지', 'إيقاف التذكيرات مؤقتًا', 'Отложить напоминания'],
  'card.pauseFor': ['Pause reminders for:', 'Pause des rappels pendant :', 'Pausar recordatorios durante:', 'Erinnerungen pausieren für:', 'Pausar lembretes por:', 'Sospendi i promemoria per:', 'Herinneringen pauzeren voor:', '暂停提醒：', 'リマインダーを止める時間:', '알림 중지 시간:', 'إيقاف التذكيرات لمدة:', 'Отложить напоминания на:'],
  'snooze.15m': ['15 minutes', '15 minutes', '15 minutos', '15 Minuten', '15 minutos', '15 minuti', '15 minuten', '15 分钟', '15分', '15분', '15 دقيقة', '15 минут'],
  'snooze.1h': ['1 hour', '1 heure', '1 hora', '1 Stunde', '1 hora', '1 ora', '1 uur', '1 小时', '1時間', '1시간', 'ساعة واحدة', '1 час'],
  'snooze.today': ['Rest of today', 'Le reste de la journée', 'Resto del día', 'Rest des Tages', 'Resto do dia', 'Resto della giornata', 'De rest van vandaag', '今天剩余时间', '今日いっぱい', '오늘 하루', 'بقية اليوم', 'До конца дня'],
  'card.howSure': ['How sure are you?', 'Êtes-vous sûr(e) ?', '¿Qué tan seguro estás?', 'Wie sicher bist du?', 'Qual é o seu grau de certeza?', 'Quanto sei sicuro?', 'Hoe zeker ben je?', '你有多确定？', 'どのくらい自信がありますか？', '얼마나 확신하나요?', 'ما مدى ثقتك؟', 'Насколько вы уверены?'],
  'card.notSure': ['Not sure', 'Pas sûr(e)', 'No estoy seguro', 'Nicht sicher', 'Não tenho certeza', 'Non sono sicuro', 'Niet zeker', '不确定', '自信なし', '확실하지 않음', 'غير متأكد', 'Не уверен'],
  'card.prettySure': ['Pretty sure', 'Assez sûr(e)', 'Bastante seguro', 'Ziemlich sicher', 'Bastante certeza', 'Abbastanza sicuro', 'Vrij zeker', '比较确定', 'かなり自信あり', '꽤 확신함', 'متأكد إلى حد كبير', 'Довольно уверен'],
  'card.ratherNot': ['Rather not say', 'Je préfère ne pas répondre', 'Prefiero no decirlo', 'Möchte ich nicht sagen', 'Prefiro não dizer', 'Preferisco non dirlo', 'Liever niet zeggen', '不想说', '答えない', '말하지 않을래요', 'أفضّل عدم القول', 'Не хочу говорить'],
  'card.close': ['Close', 'Fermer', 'Cerrar', 'Schließen', 'Fechar', 'Chiudi', 'Sluiten', '关闭', '閉じる', '닫기', 'إغلاق', 'Закрыть'],
  'card.dismiss': ['Dismiss', 'Ignorer', 'Descartar', 'Ausblenden', 'Dispensar', 'Ignora', 'Negeren', '忽略', '閉じる', '넘기기', 'تجاهل', 'Скрыть'],
  'card.keepOpen': ['Keep open', 'Garder ouverte', 'Mantener abierta', 'Offen halten', 'Manter aberta', 'Tieni aperta', 'Open houden', '保持打开', '開いたままにする', '열어 두기', 'إبقاؤها مفتوحة', 'Не закрывать'],
  'card.submit': ['Submit', 'Envoyer', 'Enviar', 'Abschicken', 'Enviar', 'Invia', 'Verzenden', '提交', '送信', '제출', 'إرسال', 'Отправить'],
  'card.checking': ['Checking your answer…', 'Vérification de votre réponse…', 'Comprobando tu respuesta…', 'Antwort wird geprüft …', 'A verificar a sua resposta…', 'Controllo della risposta…', 'Je antwoord wordt gecontroleerd…', '正在检查你的答案…', '答えを確認しています…', '답을 확인하는 중…', 'جارٍ التحقق من إجابتك…', 'Проверяем ответ…'],
  'card.working': ['Working through it…', 'Je regarde ça…', 'Revisándolo…', 'Wird bearbeitet …', 'A analisar…', 'Ci sto lavorando…', 'Bezig…', '正在处理…', '確認中…', '살펴보는 중…', 'جارٍ العمل على ذلك…', 'Разбираем…'],
  'card.thinking': ['Thinking…', 'Réflexion…', 'Pensando…', 'Einen Moment …', 'A pensar…', 'Sto pensando…', 'Even denken…', '思考中…', '考え中…', '생각 중…', 'جارٍ التفكير…', 'Думаем…'],
  'card.explainMore': ['Explain More', 'Expliquer davantage', 'Explicar más', 'Mehr erklären', 'Explicar mais', 'Spiega di più', 'Meer uitleg', '多解释一点', 'もっと説明', '더 설명', 'اشرح أكثر', 'Объяснить подробнее'],
  'card.saveNote': ['Save Note', 'Enregistrer en note', 'Guardar nota', 'Notiz speichern', 'Guardar nota', 'Salva nota', 'Notitie opslaan', '保存为笔记', 'メモに保存', '메모 저장', 'حفظ ملاحظة', 'Сохранить заметку'],
  'card.saved': ['Saved ✓', 'Enregistré ✓', 'Guardado ✓', 'Gespeichert ✓', 'Guardado ✓', 'Salvato ✓', 'Opgeslagen ✓', '已保存 ✓', '保存しました ✓', '저장됨 ✓', 'تم الحفظ ✓', 'Сохранено ✓'],
  'card.explainThis': ['Explain this →', 'Expliquer ceci →', 'Explicar esto →', 'Das erklären →', 'Explicar isto →', 'Spiega questo →', 'Leg dit uit →', '解释这个 →', 'これを説明 →', '이걸 설명 →', 'اشرح هذا ←', 'Объяснить →'],
  'card.helpQ': ['Did this help?', 'Cela vous a-t-il aidé ?', '¿Te ayudó esto?', 'Hat dir das geholfen?', 'Isto ajudou?', 'Ti è stato utile?', 'Heeft dit geholpen?', '这有帮助吗？', '役に立ちましたか？', '도움이 되었나요?', 'هل ساعدك هذا؟', 'Это помогло?'],
  'card.yes': ['Yes', 'Oui', 'Sí', 'Ja', 'Sim', 'Sì', 'Ja', '有', 'はい', '네', 'نعم', 'Да'],
  'card.notReally': ['Not really', 'Pas vraiment', 'No mucho', 'Nicht wirklich', 'Nem por isso', 'Non proprio', 'Niet echt', '不太有', 'あまり', '별로요', 'ليس كثيرًا', 'Не очень'],
  'card.thanks': ['Thanks.', 'Merci.', 'Gracias.', 'Danke.', 'Obrigado.', 'Grazie.', 'Bedankt.', '谢谢。', 'ありがとう。', '고마워요.', 'شكرًا.', 'Спасибо.'],
  'sr.title': ["How's this going?", 'Comment ça se passe ?', '¿Cómo va esto?', 'Wie läuft es?', 'Como está a correr?', 'Come sta andando?', 'Hoe gaat het?', '进展如何？', 'いかがですか？', '어떻게 되어 가나요?', 'كيف يسير الأمر؟', 'Как идёт чтение?'],
  'sr.prompt': ['Not sure how to describe this?', 'Difficile à décrire ?', '¿No sabes cómo describirlo?', 'Schwer zu beschreiben?', 'Não sabe como descrever?', 'Non sai come descriverlo?', 'Lastig te omschrijven?', '不知道怎么形容？', 'うまく言えませんか？', '어떻게 말해야 할지 모르겠나요?', 'لا تعرف كيف تصف ذلك؟', 'Трудно описать?'],
  'sr.overload': ['Too much at once', 'Trop de choses à la fois', 'Demasiado a la vez', 'Zu viel auf einmal', 'Demasiado de uma vez', 'Troppo tutto insieme', 'Te veel tegelijk', '一下子太多了', '一度に多すぎる', '한꺼번에 너무 많아요', 'الكثير دفعة واحدة', 'Слишком много сразу'],
  'sr.confusion': ["I'm stuck / don't get it", 'Je bloque / je ne comprends pas', 'Estoy atascado / no lo entiendo', 'Ich komme nicht weiter / verstehe es nicht', 'Estou preso / não percebo', 'Sono bloccato / non capisco', 'Ik zit vast / snap het niet', '我卡住了 / 看不懂', 'つまずいた / 分からない', '막혔어요 / 이해가 안 돼요', 'لا أفهم / عالق', 'Застрял / не понимаю'],
  'sr.disengaged': ['Not interested / lost focus', 'Pas intéressé(e) / distrait(e)', 'Sin interés / perdí la atención', 'Kein Interesse / abgelenkt', 'Sem interesse / perdi o foco', 'Non mi interessa / ho perso la concentrazione', 'Niet geïnteresseerd / afgeleid', '没兴趣 / 走神了', '興味がない / 集中が切れた', '흥미 없음 / 집중이 흐트러짐', 'غير مهتم / فقدت التركيز', 'Неинтересно / потерял концентрацию'],
  'sr.thanks': ['Thanks, noted.', 'Merci, noté.', 'Gracias, anotado.', 'Danke, notiert.', 'Obrigado, anotado.', 'Grazie, annotato.', 'Bedankt, genoteerd.', '谢谢，已记录。', 'ありがとう、記録しました。', '고마워요, 기록했어요.', 'شكرًا، تم التسجيل.', 'Спасибо, записали.'],
  'res.rightHigh': ['Correct, and appropriately confident.', 'Correct, et avec la bonne assurance.', 'Correcto, y con la confianza adecuada.', 'Richtig, und zu Recht sicher.', 'Correto, e com a confiança certa.', 'Corretto, e con la giusta sicurezza.', 'Juist, en terecht zelfverzekerd.', '正确，信心也恰当。', '正解で、自信も適切です。', '정답이고, 자신감도 적절해요.', 'صحيح، وبثقة مناسبة.', 'Верно, и уверенность оправданна.'],
  'res.rightLow': ['Correct. You knew more than you thought.', 'Correct. Vous en saviez plus que vous ne pensiez.', 'Correcto. Sabías más de lo que creías.', 'Richtig. Du wusstest mehr, als du dachtest.', 'Correto. Sabia mais do que pensava.', 'Corretto. Sapevi più di quanto pensassi.', 'Juist. Je wist meer dan je dacht.', '正确。你知道的比你以为的多。', '正解です。思っていたより分かっていました。', '정답이에요. 생각보다 더 알고 있었네요.', 'صحيح. كنت تعرف أكثر مما تظن.', 'Верно. Вы знали больше, чем думали.'],
  'res.wrongHigh': ['Not quite, and you were sure.', 'Pas tout à fait, et vous étiez sûr(e).', 'No exactamente, y estabas seguro.', 'Nicht ganz, und du warst dir sicher.', 'Não exatamente, e tinha a certeza.', 'Non proprio, e eri sicuro.', 'Niet helemaal, en je was zeker.', '不太对，而你当时很确定。', '惜しい。しかも自信がありました。', '아쉽네요. 확신하고 있었어요.', 'ليس تمامًا، وكنت متأكدًا.', 'Не совсем, а вы были уверены.'],
  'res.wrongLow': ["Not quite, and you weren't sure.", "Pas tout à fait, et vous n'étiez pas sûr(e).", 'No exactamente, y no estabas seguro.', 'Nicht ganz, und du warst dir nicht sicher.', 'Não exatamente, e não tinha a certeza.', 'Non proprio, e non eri sicuro.', 'Niet helemaal, en je was niet zeker.', '不太对，你当时也不确定。', '惜しい。自信もありませんでした。', '아쉽네요. 확신하지 못했어요.', 'ليس تمامًا، ولم تكن متأكدًا.', 'Не совсем, и вы не были уверены.'],
  'res.thatsRight': ["That's right.", 'C’est exact.', 'Es correcto.', 'Das stimmt.', 'Está certo.', 'Esatto.', 'Dat klopt.', '没错。', '正解です。', '맞아요.', 'هذا صحيح.', 'Верно.'],
  'res.looksRight': ['That looks right.', 'Cela semble juste.', 'Parece correcto.', 'Das sieht richtig aus.', 'Parece certo.', 'Sembra giusto.', 'Dat lijkt juist.', '看起来对。', '合っているようです。', '맞는 것 같아요.', 'يبدو هذا صحيحًا.', 'Похоже, верно.'],
  'res.notQuite': ['Not quite.', 'Pas tout à fait.', 'No exactamente.', 'Nicht ganz.', 'Não exatamente.', 'Non proprio.', 'Niet helemaal.', '不太对。', '惜しい。', '아쉬워요.', 'ليس تمامًا.', 'Не совсем.'],
  'res.cantConfirmEither': ["Couldn't confirm that one either way.", "Impossible de trancher pour celle-ci.", 'No pude confirmar ésta en ningún sentido.', 'Das ließ sich weder bestätigen noch widerlegen.', 'Não consegui confirmar esta nem num sentido nem noutro.', 'Non sono riuscito a confermare questa, né in un senso né nell’altro.', 'Dit kon ik niet bevestigen of weerleggen.', '这个我无法判断对错。', 'これは正誤を判断できませんでした。', '이건 맞고 틀림을 판단하지 못했어요.', 'لم أتمكن من التأكد من هذه في أي اتجاه.', 'Не удалось подтвердить или опровергнуть.'],
  'res.principle': ["Here's the principle it was about:", 'Voici le principe concerné :', 'Este es el principio del que trataba:', 'Darum ging es im Kern:', 'Este é o princípio em causa:', 'Ecco il principio in questione:', 'Dit was het onderliggende principe:', '它涉及的原理是：', 'これが関係する原則です:', '관련된 원리는 이거예요:', 'هذا هو المبدأ المقصود:', 'Вот принцип, о котором шла речь:'],
  'res.passageSays': ['The passage says:', 'Le passage dit :', 'El pasaje dice:', 'Im Text steht:', 'O texto diz:', 'Il testo dice:', 'De tekst zegt:', '文中写道：', '文章にはこうあります:', '본문에는 이렇게 쓰여 있어요:', 'يقول النص:', 'В тексте сказано:'],
  'res.cantConfirm': ["Couldn't confirm that one.", 'Impossible de confirmer celle-ci.', 'No pude confirmar ésta.', 'Das ließ sich nicht bestätigen.', 'Não consegui confirmar esta.', 'Non sono riuscito a confermare questa.', 'Dit kon ik niet bevestigen.', '这个我无法确认。', 'これは確認できませんでした。', '이건 확인하지 못했어요.', 'لم أتمكن من تأكيد هذه.', 'Не удалось это подтвердить.'],
  'res.notGraded': ["This one isn't graded.", "Celle-ci n'est pas notée.", 'Esta no se califica.', 'Das wird nicht bewertet.', 'Esta não é avaliada.', 'Questa non viene valutata.', 'Dit wordt niet beoordeeld.', '这题不评分。', 'これは採点しません。', '이건 채점하지 않아요.', 'هذه لا تُقيَّم.', 'Это не оценивается.'],
  'res.pointIsArgue': ['The point was making the argument.', "L'important était d'argumenter.", 'Lo importante era argumentar.', 'Es ging darum, zu argumentieren.', 'O objetivo era argumentar.', 'Il punto era argomentare.', 'Het ging erom een betoog te maken.', '重点是把理由说出来。', '大切なのは自分の主張を述べることです。', '핵심은 자기 논리를 펼치는 거예요.', 'كان المقصود هو صياغة الحجة.', 'Главное было привести аргументы.'],
  'ev.selected': ['You selected part of this passage', 'Vous avez sélectionné une partie de ce passage', 'Seleccionaste parte de este pasaje', 'Du hast einen Teil dieser Passage markiert', 'Selecionou parte desta passagem', 'Hai selezionato una parte di questo passaggio', 'Je selecteerde een deel van deze passage', '你选中了这段文字的一部分', 'この箇所の一部を選択しました', '이 구절의 일부를 선택했어요', 'حددت جزءًا من هذا المقطع', 'Вы выделили часть этого отрывка'],
  'ev.copied': ['You copied a phrase from it', 'Vous en avez copié une expression', 'Copiaste una frase de aquí', 'Du hast eine Wendung daraus kopiert', 'Copiou uma expressão daqui', 'Hai copiato una frase da qui', 'Je kopieerde een zin hieruit', '你从中复制了一个短语', 'ここからフレーズをコピーしました', '여기서 문구를 복사했어요', 'نسخت عبارة منه', 'Вы скопировали отсюда фразу'],
  'ev.scrollUneven': ['Your scrolling became uneven here', 'Votre défilement est devenu irrégulier ici', 'Tu desplazamiento se volvió irregular aquí', 'Dein Scrollen wurde hier unregelmäßig', 'O seu scroll ficou irregular aqui', 'Lo scorrimento è diventato irregolare qui', 'Je scrollen werd hier onregelmatig', '这里你的滚动变得不均匀', 'ここでスクロールが不規則になりました', '여기서 스크롤이 고르지 않았어요', 'أصبح تمريرك غير منتظم هنا', 'Здесь ваша прокрутка стала неровной'],
  'ev.movingEvenly': ['You have been moving evenly and quickly through the page', 'Vous parcourez la page de façon régulière et rapide', 'Has ido avanzando por la página de forma pareja y rápida', 'Du bewegst dich gleichmäßig und schnell durch die Seite', 'Tem percorrido a página de forma uniforme e rápida', 'Stai scorrendo la pagina in modo regolare e veloce', 'Je gaat gelijkmatig en snel door de pagina', '你在页面上匀速而快速地向下浏览', 'ページを一定の速さで素早く進んでいます', '페이지를 일정하고 빠르게 넘기고 있어요', 'كنت تتحرك في الصفحة بسرعة وبوتيرة منتظمة', 'Вы равномерно и быстро листаете страницу'],
  'ev.mouseUneven': ['Your mouse paused and changed direction a lot around here', 'Votre souris s’est souvent arrêtée et a changé de direction ici', 'Tu ratón se detuvo y cambió de dirección muchas veces por aquí', 'Deine Maus hat hier oft angehalten und die Richtung gewechselt', 'O rato parou e mudou muitas vezes de direção por aqui', 'Il mouse si è fermato e ha cambiato direzione spesso qui', 'Je muis stopte hier vaak en veranderde van richting', '你的鼠标在这里多次停顿并改变方向', 'ここでマウスが何度も止まり、向きを変えました', '여기서 마우스가 자주 멈추고 방향이 바뀌었어요', 'توقف الماوس وغيّر اتجاهه كثيرًا هنا', 'Здесь мышь часто останавливалась и меняла направление'],
  'ev.slowedDown': ['You slowed down a lot here', 'Vous avez beaucoup ralenti ici', 'Aquí fuiste mucho más despacio', 'Hier hast du stark verlangsamt', 'Abrandou bastante aqui', 'Qui hai rallentato parecchio', 'Hier ging je veel langzamer', '你在这里明显放慢了', 'ここでかなりペースが落ちました', '여기서 많이 느려졌어요', 'تباطأت كثيرًا هنا', 'Здесь вы заметно замедлились'],
  'ev.denseQuick': ['You moved through a dense paragraph quickly', 'Vous avez parcouru vite un paragraphe dense', 'Pasaste rápido por un párrafo denso', 'Du bist schnell durch einen dichten Absatz gegangen', 'Passou depressa por um parágrafo denso', 'Hai attraversato in fretta un paragrafo denso', 'Je ging snel door een dichte alinea', '你很快读过了一段内容密集的文字', '難しい段落を素早く通り過ぎました', '어려운 단락을 빠르게 지나갔어요', 'مررت بسرعة على فقرة كثيفة', 'Вы быстро прошли плотный абзац'],
  'ev.quick': ['You moved through this quickly', 'Vous avez parcouru ceci rapidement', 'Pasaste por aquí rápidamente', 'Du bist hier schnell durchgegangen', 'Passou por aqui depressa', 'Qui sei passato in fretta', 'Je ging hier snel doorheen', '你很快读过了这里', 'ここは素早く通り過ぎました', '여기를 빠르게 지나갔어요', 'مررت من هنا بسرعة', 'Вы быстро прошли это место'],
  'ev.pickedDifferent': ['You picked a different answer to the one in the passage', 'Vous avez choisi une autre réponse que celle du passage', 'Elegiste una respuesta distinta a la del pasaje', 'Du hast eine andere Antwort gewählt als die in der Passage', 'Escolheu uma resposta diferente da da passagem', 'Hai scelto una risposta diversa da quella del passaggio', 'Je koos een ander antwoord dan dat in de passage', '你选的答案与文中的不同', '文章と違う答えを選びました', '지문과 다른 답을 골랐어요', 'اخترت إجابة مختلفة عمّا في المقطع', 'Вы выбрали ответ, отличный от текста'],
  'ev.graderMisses': ['The grader thinks that answer misses something in the passage', 'Le correcteur estime que cette réponse omet un point du passage', 'El evaluador cree que esa respuesta omite algo del pasaje', 'Die Auswertung meint, dass die Antwort etwas aus der Passage auslässt', 'O avaliador acha que essa resposta omite algo da passagem', 'Il correttore ritiene che la risposta ometta qualcosa del passaggio', 'De beoordeling vindt dat het antwoord iets uit de passage mist', '评分认为这个答案漏掉了文中的一些内容', '採点では、この答えは文章の内容が一部抜けていると判断されました', '채점 결과 이 답은 지문의 내용을 놓쳤어요', 'يرى المصحّح أن هذه الإجابة تغفل شيئًا من المقطع', 'Проверка считает, что в ответе упущено что-то из текста'],
  'ev.graderRight': ['The grader thinks that answer is right', 'Le correcteur estime que cette réponse est juste', 'El evaluador cree que esa respuesta es correcta', 'Die Auswertung hält die Antwort für richtig', 'O avaliador acha que essa resposta está certa', 'Il correttore ritiene la risposta giusta', 'De beoordeling vindt het antwoord juist', '评分认为这个答案是对的', '採点では、この答えは正しいと判断されました', '채점 결과 이 답은 맞아요', 'يرى المصحّح أن هذه الإجابة صحيحة', 'Проверка считает ответ верным'],
  'ev.answeredRight': ['You answered that correctly', 'Vous avez répondu correctement', 'Respondiste correctamente', 'Du hast richtig geantwortet', 'Respondeu corretamente', 'Hai risposto correttamente', 'Je antwoordde juist', '你答对了', '正しく答えました', '정답을 맞혔어요', 'أجبت بشكل صحيح', 'Вы ответили верно'],
  'ev.saidStuck': ["You said you're stuck or don't get it", 'Vous avez dit que vous bloquez ou ne comprenez pas', 'Dijiste que estás atascado o no lo entiendes', 'Du hast gesagt, dass du nicht weiterkommst oder es nicht verstehst', 'Disse que está preso ou que não percebe', 'Hai detto che sei bloccato o non capisci', 'Je zei dat je vastzit of het niet snapt', '你说你卡住了或看不懂', '行き詰まった、または分からないと答えました', '막혔거나 이해가 안 된다고 했어요', 'قلت إنك عالق أو لا تفهم', 'Вы сказали, что застряли или не понимаете'],
  'ev.saidTooMuch': ["You said it's too much at once", 'Vous avez dit que c’est trop à la fois', 'Dijiste que es demasiado a la vez', 'Du hast gesagt, dass es zu viel auf einmal ist', 'Disse que é demasiado de uma vez', 'Hai detto che è troppo tutto insieme', 'Je zei dat het te veel tegelijk is', '你说一下子太多了', '一度に多すぎると答えました', '한꺼번에 너무 많다고 했어요', 'قلت إنه كثير دفعة واحدة', 'Вы сказали, что слишком много сразу'],
  'ev.saidDisengaged': ["You said you're not interested or lost focus", 'Vous avez dit ne pas être intéressé(e) ou avoir perdu le fil', 'Dijiste que no te interesa o perdiste la atención', 'Du hast gesagt, dass dich das nicht interessiert oder du abgelenkt bist', 'Disse que não tem interesse ou perdeu o foco', 'Hai detto che non ti interessa o hai perso la concentrazione', 'Je zei dat je niet geïnteresseerd of afgeleid bent', '你说你没兴趣或走神了', '興味がない、または集中が切れたと答えました', '흥미가 없거나 집중이 흐트러졌다고 했어요', 'قلت إنك غير مهتم أو فقدت التركيز', 'Вы сказали, что вам неинтересно или вы отвлеклись'],
  'ev.scrolledBack': ['You scrolled back to re-read', 'Vous êtes remonté(e) pour relire', 'Volviste atrás para releer', 'Du bist zurückgescrollt, um nochmal zu lesen', 'Voltou atrás para reler', 'Sei tornato indietro per rileggere', 'Je scrolde terug om opnieuw te lezen', '你往回滚动重新阅读', '読み直すためにスクロールで戻りました', '다시 읽으려고 위로 스크롤했어요', 'عدت إلى الأعلى لإعادة القراءة', 'Вы вернулись назад, чтобы перечитать'],
  'ev.scrolledBackPx': ['You scrolled back {n}px to re-read', 'Vous êtes remonté(e) de {n} px pour relire', 'Volviste {n} px atrás para releer', 'Du bist {n} px zurückgescrollt, um nochmal zu lesen', 'Voltou {n} px atrás para reler', 'Sei tornato indietro di {n} px per rileggere', 'Je scrolde {n} px terug om opnieuw te lezen', '你往回滚动了 {n} 像素重新阅读', '読み直すために {n}px 戻りました', '다시 읽으려고 {n}px 위로 스크롤했어요', 'عدت {n} بكسل إلى الأعلى لإعادة القراءة', 'Вы вернулись на {n} px, чтобы перечитать'],
  'ev.slowerThanUsual': ['You read this {f}x slower than your usual pace', 'Vous avez lu ceci {f} fois plus lentement que d’habitude', 'Leíste esto {f} veces más lento que tu ritmo habitual', 'Du hast das {f}-mal langsamer gelesen als sonst', 'Leu isto {f} vezes mais devagar do que o habitual', 'Hai letto questo {f} volte più lentamente del solito', 'Je las dit {f} keer langzamer dan normaal', '你读这里的速度比平时慢了 {f} 倍', '普段より {f} 倍ゆっくり読みました', '평소보다 {f}배 느리게 읽었어요', 'قرأت هذا أبطأ {f} مرات من وتيرتك المعتادة', 'Вы читали это в {f} раз медленнее обычного'],
  'ev.wentBackReview': ['You went back {p} to review', 'Vous êtes revenu(e) {p} en arrière pour revoir', 'Volviste {p} para repasar', 'Du bist {p} zurückgegangen, um es durchzugehen', 'Voltou {p} para rever', 'Sei tornato indietro di {p} per rivedere', 'Je ging {p} terug om het door te nemen', '你回到前面 {p} 复习', '見直すために {p} 戻りました', '복습하려고 {p} 돌아갔어요', 'عدت {p} للمراجعة', 'Вы вернулись на {p}, чтобы повторить'],
  'ev.wentBackReread': ['You went back {p} to re-read', 'Vous êtes revenu(e) {p} en arrière pour relire', 'Volviste {p} para releer', 'Du bist {p} zurückgegangen, um nochmal zu lesen', 'Voltou {p} para reler', 'Sei tornato indietro di {p} per rileggere', 'Je ging {p} terug om opnieuw te lezen', '你回到前面 {p} 重新阅读', '読み直すために {p} 戻りました', '다시 읽으려고 {p} 돌아갔어요', 'عدت {p} لإعادة القراءة', 'Вы вернулись на {p}, чтобы перечитать'],
  'ev.jumpedBack': ['You jumped straight back {p}', 'Vous êtes directement remonté(e) {p}', 'Saltaste directamente {p} atrás', 'Du bist direkt {p} zurückgesprungen', 'Saltou diretamente {p} para trás', 'Sei tornato subito indietro di {p}', 'Je sprong meteen {p} terug', '你直接跳回了 {p}', '{p} 一気に戻りました', '곧바로 {p} 돌아갔어요', 'قفزت مباشرة {p} إلى الخلف', 'Вы сразу вернулись на {p}'],
  'ev.paraOne': ['a paragraph', 'd’un paragraphe', 'un párrafo', 'einen Absatz', 'um parágrafo', 'di un paragrafo', 'één alinea', '一个段落', '1段落', '한 단락', 'فقرة واحدة', 'один абзац'],
  'ev.paraMany': ['{n} paragraphs', 'de {n} paragraphes', '{n} párrafos', '{n} Absätze', '{n} parágrafos', 'di {n} paragrafi', '{n} alinea’s', '{n} 个段落', '{n}段落', '{n}개 단락', '{n} فقرات', '{n} абзацев'],
  'ev.pickUp': ['A quick check to pick up where you left off.', 'Une vérification rapide pour reprendre là où vous vous étiez arrêté(e).', 'Una comprobación rápida para retomar donde lo dejaste.', 'Eine kurze Prüfung, um da weiterzumachen, wo du aufgehört hast.', 'Uma verificação rápida para retomar onde ficou.', 'Un controllo rapido per riprendere da dove avevi lasciato.', 'Een snelle check om verder te gaan waar je gebleven was.', '做个快速检查，接着上次的进度。', '前回の続きから、簡単に確認します。', '이어서 읽기 전에 간단히 확인해요.', 'فحص سريع لتكمل من حيث توقفت.', 'Быстрая проверка, чтобы продолжить с того места, где вы остановились.'],
  'ev.justRead': ['A quick check on what you just read.', 'Une vérification rapide sur ce que vous venez de lire.', 'Una comprobación rápida de lo que acabas de leer.', 'Eine kurze Prüfung zu dem, was du gerade gelesen hast.', 'Uma verificação rápida do que acabou de ler.', 'Un controllo rapido su ciò che hai appena letto.', 'Een snelle check over wat je net las.', '快速检查一下你刚读的内容。', '今読んだ内容を簡単に確認します。', '방금 읽은 내용을 간단히 확인해요.', 'فحص سريع لما قرأته للتو.', 'Быстрая проверка того, что вы только что прочитали.'],
  'ev.closerLook': ['This part of the reading is worth a closer look.', 'Ce passage de la lecture mérite un regard plus attentif.', 'Esta parte de la lectura merece una mirada más de cerca.', 'Diese Stelle verdient einen genaueren Blick.', 'Esta parte da leitura merece um olhar mais atento.', 'Questa parte della lettura merita uno sguardo più attento.', 'Dit deel van de tekst verdient een nadere blik.', '这部分内容值得再仔细看看。', 'この部分はもう少し詳しく見る価値があります。', '이 부분은 자세히 살펴볼 만해요.', 'هذا الجزء من القراءة يستحق نظرة أقرب.', 'Эту часть текста стоит рассмотреть внимательнее.'],
  'ev.worthChecking': ['This part of the reading is worth checking.', 'Ce passage de la lecture mérite une vérification.', 'Esta parte de la lectura merece comprobarse.', 'Diese Stelle ist eine Prüfung wert.', 'Esta parte da leitura merece ser verificada.', 'Questa parte della lettura merita un controllo.', 'Dit deel van de tekst is het controleren waard.', '这部分内容值得检查一下。', 'この部分は確認しておく価値があります。', '이 부분은 확인해 볼 만해요.', 'هذا الجزء من القراءة يستحق الفحص.', 'Эту часть текста стоит проверить.'],
  'ev.stuck': ['Time to check whether this has stuck.', 'C’est le moment de vérifier si cela est resté.', 'Es hora de comprobar si esto se te quedó.', 'Zeit zu prüfen, ob das hängen geblieben ist.', 'É altura de ver se isto ficou.', 'È ora di verificare se si è fissato.', 'Tijd om te kijken of dit is blijven hangen.', '该检查一下你是否记住了。', '身についているか確認するタイミングです。', '기억에 남았는지 확인할 때예요.', 'حان وقت التحقق مما إذا كان هذا قد ثبت.', 'Пора проверить, осталось ли это в памяти.'],
  'ev.rightConfident': ['You have been right and confident on this. Here is a harder edge of it.', 'Vous avez eu juste et avec assurance sur ce point. Voici un aspect plus difficile.', 'Has acertado con confianza en esto. Aquí tienes un ángulo más difícil.', 'Du lagst hier richtig und warst sicher. Hier ist eine schwierigere Seite davon.', 'Acertou com confiança nisto. Aqui está um ângulo mais difícil.', 'Hai risposto bene e con sicurezza su questo. Ecco un aspetto più difficile.', 'Je zat hier goed en was zeker. Hier is een lastiger kant ervan.', '这一点你答得对而且很有把握。来看看它更难的一面。', 'ここは自信を持って正解できています。もう少し難しい面を見てみましょう。', '이 부분은 자신 있게 맞혔어요. 더 어려운 면을 볼까요.', 'أجبت بشكل صحيح وبثقة هنا. إليك جانبًا أصعب منه.', 'Вы ответили верно и уверенно. Вот более трудная сторона вопроса.'],
  'ev.reviewing': ['Reviewing what you read this session', 'Révision de ce que vous avez lu pendant cette session', 'Repasando lo que leíste en esta sesión', 'Rückblick auf das, was du in dieser Sitzung gelesen hast', 'A rever o que leu nesta sessão', 'Ripasso di ciò che hai letto in questa sessione', 'Herhaling van wat je in deze sessie las', '回顾你这次阅读的内容', '今回のセッションで読んだ内容を復習します', '이번 세션에서 읽은 내용을 복습해요', 'مراجعة ما قرأته في هذه الجلسة', 'Повторение того, что вы прочитали за этот сеанс'],
  'card.noBackend': ['Could not reach the AI backend.', "Impossible de joindre le service d'IA.", 'No se pudo conectar con el servicio de IA.', 'Der KI-Dienst ist nicht erreichbar.', 'Não foi possível contactar o serviço de IA.', 'Impossibile raggiungere il servizio di IA.', 'De AI-service is niet bereikbaar.', '无法连接到 AI 服务。', 'AIサービスに接続できませんでした。', 'AI 서비스에 연결할 수 없어요.', 'تعذّر الوصول إلى خدمة الذكاء الاصطناعي.', 'Не удалось связаться с ИИ-сервисом.'],
  'card.highlightLabel': ['Highlight:', 'Surligner :', 'Resaltar:', 'Markieren:', 'Realçar:', 'Evidenzia:', 'Markeren:', '高亮：', 'ハイライト:', '형광펜:', 'تمييز:', 'Выделить:'],
  'card.removeHighlight': ['Remove highlight', 'Retirer le surlignage', 'Quitar resaltado', 'Markierung entfernen', 'Remover realce', 'Rimuovi evidenziazione', 'Markering verwijderen', '移除高亮', 'ハイライトを削除', '형광펜 지우기', 'إزالة التمييز', 'Убрать выделение'],
  'card.allHighlights': ['All highlights →', 'Tous les surlignages →', 'Todos los resaltados →', 'Alle Markierungen →', 'Todos os realces →', 'Tutte le evidenziazioni →', 'Alle markeringen →', '全部高亮 →', 'すべてのハイライト →', '모든 형광펜 →', 'كل التمييزات ←', 'Все выделения →'],
  'conn.header': ['Connections', 'Liens', 'Conexiones', 'Verbindungen', 'Ligações', 'Collegamenti', 'Verbanden', '关联', 'つながり', '연결', 'الروابط', 'Связи'],
  'conn.connectsTo': ['Connects to {title}', 'Lié à {title}', 'Se conecta con {title}', 'Verbindung zu {title}', 'Liga-se a {title}', 'Collegato a {title}', 'Sluit aan op {title}', '与《{title}》相关', '{title} とつながり', '{title}와 연결됨', 'يرتبط بـ {title}', 'Связано с «{title}»'],
  'conn.idea': ['Idea: {label}', 'Idée : {label}', 'Idea: {label}', 'Idee: {label}', 'Ideia: {label}', 'Idea: {label}', 'Idee: {label}', '概念：{label}', '概念: {label}', '개념: {label}', 'الفكرة: {label}', 'Идея: {label}'],
  'conn.open': ['Open in the workspace', 'Ouvrir dans l’espace de travail', 'Abrir en el espacio de trabajo', 'Im Workspace öffnen', 'Abrir no espaço de trabalho', 'Apri nello spazio di lavoro', 'Openen in de workspace', '在工作区中打开', 'ワークスペースで開く', '워크스페이스에서 열기', 'فتح في مساحة العمل', 'Открыть в рабочем пространстве'],
};

const EN = Object.create(null);
const TABLE = Object.create(null); // lang -> key -> text
const BY_ENGLISH = new Map();       // english text -> key
for (const lang of UI_LANGS) TABLE[lang] = Object.create(null);
for (const [key, row] of Object.entries(ROWS)) {
  if (row.length !== ORDER.length) throw new Error(`i18n row ${key} has ${row.length} entries, expected ${ORDER.length}`);
  ORDER.forEach((lang, i) => { TABLE[lang][key] = row[i]; });
  EN[key] = row[0];
  BY_ENGLISH.set(row[0], key);
}

/* "fr-CA" -> "fr"; "zh-Hant" -> "zh"; "pt-BR" -> "pt"; unknown -> "en". */
export function resolveLang(code) {
  if (typeof code !== 'string') return 'en';
  const primary = code.trim().toLowerCase().split(/[-_]/)[0];
  return UI_LANGS.includes(primary) ? primary : 'en';
}

/* The language of the page the card is on. */
export function uiLang(doc) {
  try {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    // The page's own declaration wins and is read every time (it is cheap and can change on a single-page site).
    const tagged = d?.documentElement?.lang?.trim();
    if (tagged) return resolveLang(tagged);
    return resolveLang(detectLanguage(d));
  } catch (e) { return 'en'; }
}

export function isRtl(lang) { return RTL.has(lang); }

function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/* t('card.close', 'fr') -> "Fermer". Falls back to English, then to the key. */
export function t(key, lang, vars) {
  const l = lang || uiLang();
  const text = (TABLE[l] && TABLE[l][key]) || EN[key] || key;
  return fill(text, vars);
}

/* Text another module still writes in English. Fixed wording and the few
 * sentences with a number in them are translated; anything else is returned
 * as it came. */
const PATTERNS = [
  [/^You scrolled back (\d+)px to re-read$/, 'ev.scrolledBackPx', (m) => ({ n: m[1] })],
  [/^You read this ([\d.]+)x slower than your usual pace$/, 'ev.slowerThanUsual', (m) => ({ f: m[1] })],
  [/^You went back (a paragraph|\d+ paragraphs) to review$/, 'ev.wentBackReview', (m, l) => ({ p: paragraphs(m[1], l) })],
  [/^You went back (a paragraph|\d+ paragraphs) to re-read$/, 'ev.wentBackReread', (m, l) => ({ p: paragraphs(m[1], l) })],
  [/^You jumped straight back (a paragraph|\d+ paragraphs)$/, 'ev.jumpedBack', (m, l) => ({ p: paragraphs(m[1], l) })],
];

function paragraphs(english, lang) {
  if (english === 'a paragraph') return t('ev.paraOne', lang);
  return t('ev.paraMany', lang, { n: english.split(' ')[0] });
}

export function tr(english, lang) {
  if (typeof english !== 'string' || !english) return english;
  const l = lang || uiLang();
  if (l === 'en') return english;
  const key = BY_ENGLISH.get(english.trim().replace(/[.]$/, '')) || BY_ENGLISH.get(english.trim());
  if (key) return t(key, l);
  for (const [re, k, vars] of PATTERNS) {
    const m = english.match(re);
    if (m) return t(k, l, vars(m, l));
  }
  return english;
}

export const _internals = { ROWS, EN };
