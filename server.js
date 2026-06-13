const path = require("path");
const express = require("express");
const session = require("express-session");
const methodOverride = require("method-override");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { createStore } = require("./src/store");
const { ensureSeedData } = require("./src/services/seed");
const { attachLocals } = require("./src/middleware/locals");
const { flashMessages } = require("./src/middleware/flash");
const { router } = require("./src/routes");

const app = express();
const store = createStore(path.join(__dirname, "data", "db.json"));

ensureSeedData(store);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "src", "views"));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.use(
  session({
    name: "bbp.sid",
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);
app.use(flashMessages);
app.use(
  ["/login", "/cadastro", "/recuperar"],
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(attachLocals(store));
app.use(router(store));

app.use((req, res) => {
  res.status(404).render("status", {
    title: "Pagina nao encontrada",
    message: "Nao encontramos a pagina solicitada.",
    actionHref: "/",
    actionLabel: "Voltar ao inicio"
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Bolao Brasil Placares rodando em http://localhost:${port}`);
});
