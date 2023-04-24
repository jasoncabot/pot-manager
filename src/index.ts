export interface Env {
  STATE_TOKENS: KVNamespace;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  BALANCE_SHARED_SECRET: string;
}

type AuthResponse = {
  access_token: string;
  client_id: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  token_type: string;
  user_id: string;
};

type AccountsResponse = {
  accounts: {
    id: string;
    description: string;
    created: string;
  }[];
};

type PotsResponse = {
  pots: {
    id: string;
    name: string;
    balance: number;
    cover_image_url: string;
    currency: string;
  }[];
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const origin =
      request.headers.get("Origin") ||
      request.headers.get("Referer") ||
      request.headers.get("Host");
    // read the clientId from an environment variable
    const clientId = env.CLIENT_ID;
    const clientSecret = env.CLIENT_SECRET;
    const redirectUri = `https://${origin}/auth/monzo/callback`;
    const stateToken = crypto.randomUUID();

    // read the origin from the request headers

    // if the request path is /auth/monzo then redirect the user to the Monzo API page
    const url = new URL(request.url);
    if (url.pathname.endsWith("/auth/monzo")) {
      // save the stateToken in the STATE_TOKENS KV store
      await env.STATE_TOKENS.put(`state:${stateToken}`, "1", {
        expirationTtl: 300, // give us 5 minutes to log into monzo and authorise the app
      });

      return Response.redirect(
        `https://auth.monzo.com/?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&state=${stateToken}`,
        302
      );
    } else if (url.pathname.endsWith("/auth/monzo/callback")) {
      // if the request path is /auth/monzo/callback then handle the callback from the Monzo API
      // get the code and state from the query string
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code || !state) {
        return new Response(`invalid code or state`, { status: 400 });
      }

      // ensure that the stateToken is valid
      const stateTokenValid = await env.STATE_TOKENS.get(`state:${state}`);
      if (!stateTokenValid) {
        return new Response(`invalid state token`, { status: 400 });
      }

      // exchange for an authorization code
      const authResponse = await fetch("https://api.monzo.com/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
        }),
      });

      const userId = (await this.storeAuthResponse(authResponse, env)).user_id;

      return new Response(`authenticated as ${userId}`, {
        status: 200,
        headers: { "content-type": "text/plain;charset=UTF-8" },
      });
    } else if (url.pathname.endsWith("/balances")) {
      // use a predefined secret for some very basic auth
      const expectedSecret = env.BALANCE_SHARED_SECRET;
      const secret = atob(url.searchParams.get("secret") || "").trim();
      // lookup the user id from the user query parameter
      const userId = url.searchParams.get("user_id");
      const potIds = url.searchParams.get("pot_ids") || "";
      const potIdArray = potIds.split(",");

      if (!userId || !secret || secret !== expectedSecret) {
        return new Response(`invalid secret or user_id`, { status: 400 });
      }

      let accessToken = await env.STATE_TOKENS.get(`access_token:${userId}`);
      if (!accessToken) {
        accessToken = await this.refreshAccessToken(userId, env);
      }

      // find the account id by looking at this users account and getting the first joint account id
      let accountId = await env.STATE_TOKENS.get(`account_id:${userId}`);
      if (!accountId) {
        // find the first account of type uk_retail_joint
        const accountsResponse = await fetch(
          "https://api.monzo.com/accounts?account_type=uk_retail_joint",
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );

        const accounts = (await accountsResponse.json()) as AccountsResponse;

        // store the account id of the first joint account
        accountId = accounts.accounts[0].id;
        await env.STATE_TOKENS.put(`account_id:${userId}`, accountId);
      }

      // we have a valid account id, so look up the pots and balances
      const potsResponse = await fetch(
        `https://api.monzo.com/pots?current_account_id=${accountId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const pots = (await potsResponse.json()) as PotsResponse;

      // convert the list of pots into a smaller and simpler list of balances (and images)
      const balances = pots.pots
        .filter((pot) => potIdArray.find((id) => id === pot.id))
        .map((pot) => {
          return {
            name: pot.name,
            // format the pot.balance as a currency string
            balance: new Intl.NumberFormat("en-GB", {
              style: "currency",
              currency: pot.currency,
            }).format(pot.balance / 100),
            cover_image_url: pot.cover_image_url,
          };
        });

      return new Response(JSON.stringify(balances), {
        status: 200,
        headers: { "content-type": "application/json;charset=UTF-8" },
      });
    }

    return new Response(`try /auth/monzo`, {
      status: 200,
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
  },

  async refreshAccessToken(userId: string, env: Env) {
    // read the refresh token from KV and use it to grab a new access token

    const refreshToken = await env.STATE_TOKENS.get(`refresh_token:${userId}`);
    if (!refreshToken) {
      throw new Error("no refresh token found");
    }

    const clientId = env.CLIENT_ID;
    const clientSecret = env.CLIENT_SECRET;
    const authResponse = await fetch("https://api.monzo.com/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    return (await this.storeAuthResponse(authResponse, env)).access_token;
  },

  async storeAuthResponse(authResponse: Response, env: Env) {
    // read the authorization data from the response
    const authData = (await authResponse.json()) as AuthResponse;

    // store the access and refresh_token in the STATE_TOKENS KV store
    await env.STATE_TOKENS.put(
      `access_token:${authData.user_id}`,
      authData.access_token,
      { expirationTtl: authData.expires_in }
    );
    await env.STATE_TOKENS.put(
      `refresh_token:${authData.user_id}`,
      authData.refresh_token
    );

    return authData;
  },
};
