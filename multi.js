const { Client, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const socketIO = require("socket.io");
const qrcode = require("qrcode");
const http = require("http");
const fs = require("fs");
const { phoneNumberFormatter } = require("./helpers/formatter");
const fileUpload = require("express-fileupload");
const axios = require("axios");
const mime = require("mime-types");
const port = process.env.PORT || 8000;

// koneksi ke database
// var mysql = require("mysql");
// var db = mysql.createConnection({
//   host: "localhost",
//   user: "root",
//   password: "",
//   database: "blast_landing",
// });
// db.connect(function (err) {
//   if (err) throw err;
//   console.log("Connected!");
// });

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(
  express.urlencoded({
    extended: true,
  })
);

app.get("/", (req, res) => {
  res.sendFile("index.html", {
    root: __dirname,
  });
});

// app.get("/api_wa", (req, res) => {
//   res.sendFile("index.html", {
//     root: __dirname,
//   });
// });

const sessions = [];
const SESSIONS_FILE = "./whatsapp-sessions.json";

const createSessionsFileIfNotExists = function () {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log("Sessions file created successfully.");
    } catch (err) {
      console.log("Failed to create sessions file: ", err);
    }
  }
};

createSessionsFileIfNotExists();

const setSessionsFile = function (sessions) {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function (err) {
    if (err) {
      console.log(err);
    }
  });
};

const getSessionsFile = function () {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE));
};

const createSession = function (id, description) {
  console.log("Creating session: " + id);
  const SESSION_FILE_PATH = `./whatsapp-session-${id}.json`;
  let sessionCfg;
  // let data = {
  //   api_key: id,
  // };
  // let sql = "UPDATE account SET ? WHERE username='" + description + "'";
  // let query = db.query(sql, data, (err, results) => {
  //   if (err) {
  //     console.log("error");
  //   } else {
  //     console.log("success");
  //   }
  // });
  if (fs.existsSync(SESSION_FILE_PATH)) {
    sessionCfg = require(SESSION_FILE_PATH);
  }

  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process", // <- this one doesn't works in Windows
        "--disable-gpu",
      ],
    },
    session: sessionCfg,
  });

  client.initialize();

  client.on("qr", (qr) => {
    console.log("QR RECEIVED", qr);
    qrcode.toDataURL(qr, (err, url) => {
      io.emit("qr", { id: id, src: url });
      io.emit("message", { id: id, text: "QR Code received, scan please!" });
    });
  });

  client.on("ready", () => {
    io.emit("ready", { id: id });
    io.emit("message", { id: id, text: "Whatsapp is ready!" });

    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex((sess) => sess.id == id);
    savedSessions[sessionIndex].ready = true;
    setSessionsFile(savedSessions);
  });

  client.on("authenticated", (session) => {
    io.emit("authenticated", { id: id });
    io.emit("message", { id: id, text: "Whatsapp is authenticated!" });
    sessionCfg = session;
    fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session), function (err) {
      if (err) {
        console.error(err);
      }
    });
  });

  client.on("auth_failure", function (session) {
    io.emit("message", { id: id, text: "Auth failure, restarting..." });
  });

  client.on("disconnected", (reason) => {
    io.emit("message", { id: id, text: "Whatsapp is disconnected!" });
    fs.unlinkSync(SESSION_FILE_PATH, function (err) {
      if (err) return console.log(err);
      console.log("Session file deleted!");
    });
    client.destroy();
    client.initialize();

    // Menghapus pada file sessions
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex((sess) => sess.id == id);
    savedSessions.splice(sessionIndex, 1);
    setSessionsFile(savedSessions);

    io.emit("remove-session", id);
  });

  // Tambahkan client ke sessions
  sessions.push({
    id: id,
    description: description,
    client: client,
  });

  // Menambahkan session ke file
  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex((sess) => sess.id == id);

  if (sessionIndex == -1) {
    savedSessions.push({
      id: id,
      description: description,
      ready: false,
    });
    setSessionsFile(savedSessions);
  }
};

const init = function (socket) {
  const savedSessions = getSessionsFile();
  console.log(savedSessions);
  if (savedSessions.length > 0) {
    if (socket) {
      socket.emit("init", savedSessions);
    } else {
      savedSessions.forEach((sess) => {
        createSession(sess.id, sess.description);
      });
    }
  }
};

init();

// Socket IO
io.on("connection", function (socket) {
  init(socket);

  socket.on("create-session", function (data) {
    console.log("Create session: " + data.id);
    createSession(data.id, data.description);
  });
});

// Send message

function kirim_message(sender, number, message, res) {
  const client = sessions.find((sess) => sess.id == sender).client;
  client
    .sendMessage(number, message)
    .then((response) => {
      res.status(200).json({
        status: true,
        response: response,
      });
    })
    .catch((err) => {
      kirim_message(number, message, res);
    });
}

app.post("/send-message", (req, res) => {
  const sender = req.body.sender;
  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;
  kirim_message(sender, number, message, res);
});

//send media
app.post("/send-media", async (req, res) => {
  const sender = req.body.sender;
  const number = phoneNumberFormatter(req.body.number);
  const caption = req.body.caption;
  const fileUrl = req.body.file;

  // const media = MessageMedia.fromFilePath('./image-example.png');
  // const file = req.files.file;
  // const media = new MessageMedia(file.mimetype, file.data.toString('base64'), file.name);
  let mimetype;
  const attachment = await axios
    .get(fileUrl, {
      responseType: "arraybuffer",
    })
    .then((response) => {
      mimetype = response.headers["content-type"];
      return response.data.toString("base64");
    });

  const client = sessions.find((sess) => sess.id == sender).client;
  const media = new MessageMedia(mimetype, attachment, "Media");

  client
    .sendMessage(number, media, {
      caption: caption,
    })
    .then((response) => {
      res.status(200).json({
        status: true,
        response: response,
      });
    })
    .catch((err) => {
      res.status(500).json({
        status: false,
        response: err,
      });
    });
});

server.listen(port, function () {
  console.log("App running on *: " + port);
});
