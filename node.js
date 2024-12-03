const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();
const chokidar = require('chokidar');

const app = express();
const port = 3000;
const clients = {}; // Store client sessions and QR code cache by user ID

const QR_CACHE_DURATION = 20000; // Cache duration of 20 seconds
const QR_GENERATION_TIMEOUT = 15000; // 15-second timeout for generating a new QR code

// Configure AWS S3 Client
const s3 = new S3Client({
    endpoint: process.env.AWS_ENDPOINT, // AWS S3 or compatible endpoint
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


const uploadDirectoryToS3 = async (localDir, s3Prefix) => {
    const items = fs.readdirSync(localDir, { withFileTypes: true });

    for (const item of items) {
        const localPath = path.join(localDir, item.name);
        const s3Key = `${s3Prefix}${item.name}`;

        if (item.isDirectory()) {
            // Recursively handle subdirectories
            await uploadDirectoryToS3(localPath, `${s3Key}/`);
        } else {
            // Upload file
            const fileContent = fs.readFileSync(localPath);
            const command = new PutObjectCommand({
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: s3Key,
                Body: fileContent,
            });
            await s3.send(command);
            console.log(`Uploaded ${s3Key} to S3.`);
        }
    }
};

const restoreDirectoryFromS3 = async (prefix, localDir) => {
    const listCommand = new ListObjectsV2Command({
        Bucket: process.env.AWS_BUCKET_NAME,
        Prefix: prefix,
    });

    const listedObjects = await s3.send(listCommand);

    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
        console.warn(`No files found under S3 prefix ${prefix}`);
        return;
    }

    // Ensure the local directory exists
    fs.mkdirSync(localDir, { recursive: true });

    for (const { Key } of listedObjects.Contents) {
        const relativePath = Key.replace(prefix, ''); // Remove prefix to get relative file path
        const localPath = path.join(localDir, relativePath);

        if (!relativePath) {
            console.warn(`Skipping S3 key ${Key} as it resolves to a directory.`);
            continue;
        }

        // Create necessary subdirectories
        fs.mkdirSync(path.dirname(localPath), { recursive: true });

        // Download and save the file
        console.log(`Downloading ${Key} to ${localPath}`);
        await downloadFileFromS3(Key, localPath);
    }

    console.log(`Restored session directory ${localDir} from S3.`);
};

// Download an individual file
const downloadFileFromS3 = async (key, localPath) => {
    const command = new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
    });

    try {
        const { Body } = await s3.send(command);

        if (fs.existsSync(localPath) && fs.lstatSync(localPath).isDirectory()) {
            console.warn(`Cannot write to ${localPath} because it is a directory.`);
            return;
        }

        const fileStream = fs.createWriteStream(localPath);
        return new Promise((resolve, reject) => {
            Body.pipe(fileStream)
                .on('finish', resolve)
                .on('error', reject);
        });
    } catch (err) {
        console.error(`Error downloading file ${key} from S3:`, err);
        throw err;
    }
};

const restoreDirectoryFromS3 = async (prefix, localDir) => {
    const listCommand = new ListObjectsV2Command({
        Bucket: process.env.AWS_BUCKET_NAME,
        Prefix: prefix,
    });

    const listedObjects = await s3.send(listCommand);

    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
        console.warn(`No files found under S3 prefix ${prefix}`);
        return;
    }

    // Ensure the local directory exists
    fs.mkdirSync(localDir, { recursive: true });

    for (const { Key } of listedObjects.Contents) {
        const relativePath = Key.replace(prefix, ''); // Remove prefix to get relative file path
        const localPath = path.join(localDir, relativePath);

        if (!relativePath) {
            console.warn(`Skipping S3 key ${Key} as it resolves to a directory.`);
            continue;
        }

        // Create necessary subdirectories
        fs.mkdirSync(path.dirname(localPath), { recursive: true });

        // Download and save the file
        console.log(`Downloading ${Key} to ${localPath}`);
        await downloadFileFromS3(Key, localPath);
    }

    console.log(`Restored session directory ${localDir} from S3.`);
};




// Helper Functions for S3 Operations
const uploadToS3 = async (key, content) => {
    const command = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        Body: content,
    });
    await s3.send(command);
    console.log(`Uploaded ${key} to S3.`);
};

const downloadFromS3 = async (key) => {
    const command = new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
    });

    try {
        const { Body } = await s3.send(command);
        const chunks = [];
        for await (const chunk of Body) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    } catch (err) {
        if (err.name === 'NoSuchKey') {
            console.log(`Key ${key} does not exist in S3. This is normal for new sessions.`);
            return null; // Return null for non-existing keys
        }
        throw err; // Re-throw other errors
    }
};

const deleteFromS3 = async (prefix) => {
    const listCommand = new ListObjectsV2Command({
        Bucket: process.env.AWS_BUCKET_NAME,
        Prefix: prefix,
    });

    const listedObjects = await s3.send(listCommand);
    if (!listedObjects.Contents || listedObjects.Contents.length === 0) return;

    const deleteCommand = new DeleteObjectsCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Delete: { Objects: listedObjects.Contents.map(({ Key }) => ({ Key })) },
    });

    await s3.send(deleteCommand);
    console.log(`Deleted all objects with prefix ${prefix} from S3.`);
};

const watchAndUploadSession = (userId) => {
    const sessionDir = path.resolve(`.wwebjs_auth/session-${userId}`);
    const sessionPrefix = `wwebjs_auth/session-${userId}/`;

    const watcher = chokidar.watch(sessionDir, { persistent: true });

    watcher.on('change', async (filePath) => {
        const relativePath = path.relative(sessionDir, filePath);
        const s3Key = `${sessionPrefix}${relativePath}`;

        console.log(`File changed: ${filePath}, uploading to S3 as ${s3Key}`);
        const fileContent = fs.readFileSync(filePath);
        await uploadToS3(s3Key, fileContent);
    });

    watcher.on('add', async (filePath) => {
        const relativePath = path.relative(sessionDir, filePath);
        const s3Key = `${sessionPrefix}${relativePath}`;

        console.log(`New file detected: ${filePath}, uploading to S3 as ${s3Key}`);
        const fileContent = fs.readFileSync(filePath);
        await uploadToS3(s3Key, fileContent);
    });

    watcher.on('unlink', async (filePath) => {
        const relativePath = path.relative(sessionDir, filePath);
        const s3Key = `${sessionPrefix}${relativePath}`;

        console.log(`File deleted: ${filePath}, removing from S3 as ${s3Key}`);
        await deleteFromS3(s3Key);
    });

    console.log(`Watching session directory for user ${userId}.`);
};



// Initialize WhatsApp Client
const initializeClient = async (userId, res) => {
    const sessionDir = path.resolve(`.wwebjs_auth/session-${userId}`);
    
    const sessionPrefix = `./wwebjs_auth/session-${userId}/`;

    // Download session data from S3
    console.log(`Restoring session for user ${userId} from S3.`);
    await restoreDirectoryFromS3(sessionPrefix, sessionDir);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId, dataPath: path.resolve('.wwebjs_auth') }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    });

    clients[userId] = { client, isReady: false, qrCode: null, qrGeneratedAt: null };

    client.on('ready', async () => {
        console.log(`Client for user ${userId} is ready.`);
        clients[userId].isReady = true;

        // Upload the full session directory to S3
        watchAndUploadSession(userId);
        console.log(`Uploading session directory for user ${userId} to S3.`);
        await uploadDirectoryToS3(sessionDir, sessionPrefix);
        console.log(`Session directory for user ${userId} uploaded to S3.`);
    });

    client.on('qr', async (qr) => {
        console.log(`QR Code received for user ${userId}`);
        const qrCodeUrl = await qrcode.toDataURL(qr);
        clients[userId].qrCode = qrCodeUrl;
        clients[userId].qrGeneratedAt = Date.now();
        if (res) res.json({ qr: qrCodeUrl });
    });


    client.initialize();
};

// Routes

app.get('/get-qr/:userId', (req, res) => {
    const userId = req.params.userId;

    if (clients[userId] && clients[userId].isReady) {
        return res.json({ status: 'success', message: 'Session already active' });
    }

    initializeClient(userId, res).catch((error) => {
        console.error('Failed to initialize client:', error);
        res.status(500).json({ status: 'error', message: 'Failed to initialize client' });
    });
});

app.get('/check-active/:userId', (req, res) => {
    const userId = req.params.userId;
    if (clients[userId] && clients[userId].isReady) {
        res.json({ status: 'success', message: 'Session already active' });
    } else {
        res.json({ status: 'error', message: 'Session is not active' });
    }
});

app.post('/send-message/:userId', async (req, res) => {
    const userId = req.params.userId;
    const { phoneNumber, message } = req.body;

    if (!clients[userId] || !clients[userId].isReady) {
        return res.status(400).json({ status: 'error', message: 'Session is not active' });
    }

    const client = clients[userId].client;

    try {
        const response = await client.sendMessage(`${phoneNumber}@c.us`, message);
        res.json({ status: 'success', response });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ status: 'error', message: 'Failed to send message' });
    }
});

app.post('/send-bulk-messages/:userId', async (req, res) => {
    const userId = req.params.userId;
    const messageList = req.body;

    if (!clients[userId] || !clients[userId].isReady) {
        return res.status(400).json({ status: 'error', message: 'Session not active' });
    }

    const client = clients[userId].client;
    const results = {};

    for (const [phoneNumber, message] of Object.entries(messageList)) {
        try {
            const response = await client.sendMessage(`${phoneNumber}@c.us`, message);
            results[phoneNumber] = { status: 'success', response };
        } catch (error) {
            console.error(`Error sending message to ${phoneNumber}:`, error.message || error);
            results[phoneNumber] = { status: 'error', error: error.message || 'An error occurred' };
        }
    }

    res.json(results);
});

app.post('/logout/:userId', async (req, res) => {
    const userId = req.params.userId;
    const sessionPrefix = `wwebjs_auth/session-${userId}/`;

    if (!clients[userId]) {
        return res.status(404).json({ status: 'error', message: 'No active session found' });
    }

    try {
        await clients[userId].client.destroy();
        console.log(`Client for user ${userId} destroyed.`);

        // Delete session from S3
        await deleteFromS3(sessionPrefix);
        console.log(`Session for user ${userId} deleted from S3.`);

        delete clients[userId];
        res.json({ status: 'success', message: `User ${userId} successfully logged out.` });
    } catch (error) {
        console.error('Error during logout:', error);
        res.status(500).json({ status: 'error', message: 'Failed to log out user.' });
    }
});

app.listen(port, () => {
    console.log(`WhatsApp server listening on port ${port}`);
});
