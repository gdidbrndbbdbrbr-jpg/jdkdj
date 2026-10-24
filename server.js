const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

// فلتر الكلمات البذيئة والسيئة للحماية
const badWords = ['حمار', 'كلب', 'قندرة', 'تفلش', 'سخيف', 'لعنة', 'زفت'];
function containsBadWord(text) {
    if (!text) return false;
    return badWords.some(word => text.toLowerCase().includes(word));
}

io.on('connection', (socket) => {
    socket.on('get-public-rooms', () => {
        const publicRooms = [];
        for (const code in rooms) {
            if (rooms[code].isPublic && rooms[code].gameState === 'lobby') {
                publicRooms.push({ code: code, hostName: rooms[code].players[0]?.name || 'مضيف' });
            }
        }
        socket.emit('public-rooms-list', publicRooms);
    });

    socket.on('create-room', ({ playerName, roomCode, isPublic }) => {
        if (containsBadWord(playerName)) {
            socket.emit('error-msg', 'اسمك يحتوي على كلمات غير مسموحة!');
            return;
        }

        if (rooms[roomCode]) {
            socket.emit('error-msg', 'رمز الغرفة مستخدم بالفعل.');
            return;
        }

        rooms[roomCode] = {
            code: roomCode,
            hostId: socket.id,
            hostName: playerName,
            isPublic: isPublic,
            players: [{ id: socket.id, name: playerName, score: 0 }],
            gameState: 'lobby',
            currentQuestion: null,
            timer: null,
            answersLog: [],
            bannedNames: []
        };

        socket.join(roomCode);
        socket.emit('room-created', rooms[roomCode]);
    });

    socket.on('join-room', ({ playerName, roomCode }) => {
        if (containsBadWord(playerName)) {
            socket.emit('error-msg', 'اسمك يحتوي على كلمات غير مسموحة!');
            return;
        }

        const room = rooms[roomCode];
        if (!room) {
            socket.emit('error-msg', 'الغرفة غير موجودة!');
            return;
        }

        if (room.bannedNames && room.bannedNames.includes(playerName)) {
            socket.emit('error-msg', 'تم حظرك من هذه الغرفة بواسطة المالك!');
            return;
        }

        if (room.gameState !== 'lobby') {
            socket.emit('error-msg', 'اللعبة جارية الآن.');
            return;
        }

        if (room.players.some(p => p.id === socket.id)) return;

        room.players.push({ id: socket.id, name: playerName, score: 0 });
        socket.join(roomCode);
        
        io.to(roomCode).emit('update-room', room);
        socket.emit('joined-success', room);
    });

    // استعادة الغرفة إذا كان المضيف هو نفسه
    socket.on('restore-host-room', ({ roomCode, hostName }) => {
        const room = rooms[roomCode];
        if (room && room.hostName === hostName) {
            room.hostId = socket.id;
            socket.join(roomCode);
            socket.emit('room-restored', room);
            io.to(roomCode).emit('update-room', room);
        } else {
            socket.emit('error-msg', 'لم يتم العثور على الغرفة أو أنك لست المالك الأصلي.');
        }
    });

    socket.on('send-question', ({ roomCode, questionData }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;

        room.gameState = 'question';
        room.answersLog = [];
        // النقاط ثابتة حصراً 15 كحد أقصى
        questionData.points = 15;

        room.currentQuestion = {
            ...questionData,
            startTime: Date.now()
        };

        const sanitizedQuestion = {
            type: questionData.type,
            questionText: questionData.questionText,
            options: questionData.options || [],
            timeLimit: questionData.timeLimit || 15
        };

        io.to(roomCode).emit('new-question', sanitizedQuestion);
        io.to(room.hostId).emit('host-question-started', questionData);

        if (room.timer) clearTimeout(room.timer);
        room.timer = setTimeout(() => {
            triggerTimeUp(roomCode);
        }, (questionData.timeLimit || 15) * 1000);
    });

    socket.on('force-end-question', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id || room.gameState !== 'question') return;
        if (room.timer) clearTimeout(room.timer);
        triggerTimeUp(roomCode);
    });

    function triggerTimeUp(roomCode) {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'question') return;
        room.gameState = 'time-up';
        io.to(roomCode).emit('time-up', { correctAnswer: room.currentQuestion.correctAnswer, log: room.answersLog });
    }

    socket.on('submit-answer', ({ roomCode, answer }) => {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'question') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (room.answersLog.some(a => a.playerId === socket.id)) return;

        const q = room.currentQuestion;
        let isCorrect = false;

        const cleanAns = String(answer).trim().toLowerCase();
        const cleanCorrect = String(q.correctAnswer).trim().toLowerCase();

        if (q.type === 'mcq' || q.type === 'tf') {
            isCorrect = cleanAns === cleanCorrect;
        } else if (q.type === 'order') {
            isCorrect = JSON.stringify(answer) === JSON.stringify(q.correctAnswer);
        } else if (q.type === 'correct_error' || q.type === 'math_free') {
            // مطابقة الإجابة الرياضية أو النصية مع تصحيح الخطأ
            isCorrect = cleanAns === cleanCorrect || cleanAns.replace(/\s+/g, '') === cleanCorrect.replace(/\s+/g, '');
        }

        const timeTaken = ((Date.now() - q.startTime) / 1000).toFixed(2);
        const pointsAwarded = isCorrect ? 15 : 0; // النقاط ثابتة 15

        if (isCorrect) {
            player.score += pointsAwarded;
        }

        room.answersLog.push({
            playerId: socket.id,
            playerName: player.name,
            answer: answer,
            isCorrect: isCorrect,
            timeTaken: timeTaken,
            points: pointsAwarded
        });

        room.answersLog.sort((a, b) => a.timeTaken - b.timeTaken);

        socket.emit('answer-result', { correct: isCorrect, points: pointsAwarded });
        io.to(room.hostId).emit('update-answers-log', room.answersLog);
        io.to(roomCode).emit('update-scores', room.players);
    });

    socket.on('return-to-lobby', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        room.gameState = 'lobby';
        io.to(roomCode).emit('back-to-lobby', room);
    });

    socket.on('send-chat', ({ roomCode, sender, message }) => {
        if (containsBadWord(message)) {
            socket.emit('error-msg', 'رسالتك تحتوي على كلمات محظورة بواسطة نظام الحماية!');
            return;
        }
        io.to(roomCode).emit('receive-chat', { sender, message });
    });

    socket.on('send-reaction', ({ roomCode, emoji }) => {
        io.to(roomCode).emit('receive-reaction', emoji);
    });

    socket.on('end-game', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        room.players.sort((a, b) => b.score - a.score);
        io.to(roomCode).emit('game-over', room.players);
    });

    socket.on('kick-player', ({ roomCode, targetId }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        const targetPlayer = room.players.find(p => p.id === targetId);
        if (targetPlayer) {
            if (!room.bannedNames) room.bannedNames = [];
            room.bannedNames.push(targetPlayer.name);
        }
        room.players = room.players.filter(p => p.id !== targetId);
        io.to(targetId).emit('kicked');
        io.to(roomCode).emit('update-room', room);
    });

    socket.on('close-room', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        io.to(roomCode).emit('room-closed');
        delete rooms[roomCode];
    });

    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                if (room.hostId === socket.id) {
                    // المضيف خرج، لا نحذف الغرفة فوراً بل نتركها 5 دقائق لكي يستطيع استعادتها
                    room.hostId = null;
                } else {
                    room.players.splice(playerIndex, 1);
                    io.to(code).emit('update-room', room);
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`السيرفر يعمل على: http://localhost:${PORT}`);
});