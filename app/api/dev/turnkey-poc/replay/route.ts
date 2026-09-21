import { isTurnkeyPocEnabled } from "@/lib/poc/turnkey/config";
import { asErrorMessage, disabledResponse, jsonError } from "@/lib/poc/turnkey/server/http";

export async function POST(request: Request) {
  if (!isTurnkeyPocEnabled()) return disabledResponse();
  try {
    const body = (await request.json()) as {
      url?: string;
      stampHeaderName?: string;
      stampHeaderValue?: string;
      requestBody?: string;
    };
    if (!body.url || !body.stampHeaderName || !body.stampHeaderValue || !body.requestBody) {
      return jsonError("Stamped request is required.", 400);
    }

    const turnkeyUrl = new URL(body.url);
    if (turnkeyUrl.hostname !== "api.turnkey.com") {
      return jsonError("Replay proxy only forwards to api.turnkey.com.", 400);
    }

    const response = await fetch(turnkeyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [body.stampHeaderName]: body.stampHeaderValue,
      },
      body: body.requestBody,
    });

    const text = await response.text();
    return Response.json({
      ok: response.ok,
      status: response.status,
      bodyPreview: text.slice(0, 500),
    });
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
