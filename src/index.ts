import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: `.env.local` });

import { URL } from "url";
import Koa from "koa";
import nunjucks from "nunjucks";
import views from "koa-views";
import send from "koa-send";
import bodyParser from "koa-bodyparser";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

const app = new Koa();

const viewsPath = new URL("../views", import.meta.url).pathname;

const nunjucksEnv = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(viewsPath)
);

const render = views(viewsPath, {
  extension: "njk",
  map: {
    njk: "nunjucks",
  },
  options: {
    nunjucksEnv,
  },
});

app.use(render);

app.use(bodyParser());

// Any shortcode redirects
app.use(async (ctx, next) => {
  const shortcode = /^\/\+[a-zA-Z0-9]*/;

  const match = shortcode.exec(ctx.path);
  if (match) {
    const code = match[0].replace("/", "").replace("+", "");

    const url = await redis.get(`shortcode:${code}`);
    if (url) {
      await redis.incr(`hits:${code}`);

      ctx.redirect(url);
    } else {
      ctx.status = 404;
    }
  } else {
    await next();
  }
});

// Serve CSS
const cssPath = new URL("../dist", import.meta.url).pathname;

app.use(async (ctx, next) => {
  if (ctx.path === "/output.css") {
    await send(ctx, "output.css", { root: cssPath });
  } else {
    await next();
  }
});

// Grant auth token on flow
app.use(async (ctx, next) => {
  if (ctx.path.startsWith("/oauth2")) {
    const accessTokenParams = new URLSearchParams();
    accessTokenParams.append(
      "client_id",
      process.env.GITHUB_CLIENT_ID as string
    );
    accessTokenParams.append(
      "client_secret",
      process.env.GITHUB_CLIENT_SECRET as string
    );
    accessTokenParams.append("code", ctx.query.code as string);
    accessTokenParams.append(
      "redirect_uri",
      process.env.GITHUB_REDIRECT_URI as string
    );

    const githubToken = await fetch(
      "https://github.com/login/oauth/access_token?" + accessTokenParams,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
      }
    ).then((resp) => resp.json() as any);

    const userInfo = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${githubToken.access_token}`,
      },
    }).then((resp) => resp.json() as any);

    const token = jwt.sign(
      {
        user: userInfo.id,
        username: userInfo.login,
        name: userInfo.name,
      },
      process.env.JWT_SECRET as string
    );

    ctx.cookies.set("token", token);

    ctx.redirect("/");
  } else {
    await next();
  }
});

// If no auth, show login page
app.use(async (ctx, next) => {
  if (!ctx.cookies.get("token")) {
    await ctx.render("login", {
      login_url: `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=user:email`,
    });
  } else {
    await next();
  }
});

// Require auth to proceed further

// Verify JWT
app.use(async (ctx, next) => {
  const token = ctx.cookies.get("token");

  if (!token) {
    console.log("No Token");
    ctx.status = 401;
    return;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    ctx.status = 500;
    return;
  }

  let decoded = {};
  try {
    decoded = jwt.verify(token, secret);
  } catch (err) {
    console.log("Could not decode");
    ctx.status = 401;
    return;
  }

  ctx.user = decoded;
  await next();
});

// Perform logout on request
app.use(async (ctx, next) => {
  if (ctx.path === "/logout") {
    ctx.cookies.set("token");
    ctx.redirect("/");
  } else {
    await next();
  }
});

function generateShortcode() {
  const chars = "23456789CFGHJMPQRVWX";

  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

// Handle creating new links
app.use(async (ctx, next) => {
  if (ctx.path === "/create" && ctx.method === "POST") {
    const url = ctx.request.body.url;

    let code = generateShortcode();

    while (await redis.get(code)) {
      code = generateShortcode();
    }

    console.log(code, url);

    await redis.set(`shortcode:${code}`, url);
    await redis.sadd(`user:${ctx.user.user}:codes`, code);

    ctx.redirect("/");
  } else {
    await next();
  }
});

// Handle deleting links
app.use(async (ctx, next) => {
  if (ctx.path === "/delete" && ctx.method === "POST") {
    const code = ctx.request.body.code;

    await redis.srem(`user:${ctx.user.user}:codes`, code);
    await redis.del(`shortcode:${code}`);

    ctx.redirect("/");
  } else {
    await next();
  }
});

// Handle editing links
app.use(async (ctx, next) => {
  if (ctx.path === "/edit" && ctx.method === "POST") {
    const code = ctx.request.body.code;
    const url = ctx.request.body.url;

    await redis.set(`shortcode:${code}`, url);

    ctx.redirect("/");
  } else {
    await next();
  }
});

app.use(async (ctx) => {
  if (ctx.path !== "/") {
    // console.log("unhandled", ctx.path);
    ctx.redirect("/");
  }

  const codes = await redis.smembers(`user:${ctx.user.user}:codes`);

  const links = await Promise.all(
    codes.map(async (code) => {
      const url = await redis.get(`shortcode:${code}`);
      const hits = (await redis.get(`hits:${code}`)) || 0;
      return {
        code,
        url,
        hits,
      };
    })
  );

  await ctx.render("dashboard", {
    name: ctx.user.name,
    links,
    baseURL: process.env.BASE_URL,
  });
});

app.listen(5000);
