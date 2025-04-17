// -------------- Helper：写入 Supabase -----------------
async function insertIntoSupabase(table, payload, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"   // 返回插入结果，调试用
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error(`Supabase error (${table}):`, txt);
    throw new Error(`Supabase insert failed: ${res.status}`);
  }
}

// -------------- Helper：验证 Shopify HMAC --------------
async function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expectedHmac = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return expectedHmac === hmacHeader;
}

// -------------- Worker 入口 ----------------------------
export default {
  async fetch(request, env, ctx) {
    // 仅接受 POST
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 读取并验证 HMAC
    const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
    const rawBody   = await request.text();
    const valid     = await verifyShopifyHmac(rawBody, hmacHeader, env.SHOPIFY_SECRET);
    if (!valid) {
      return new Response("Invalid HMAC", { status: 401 });
    }

    // 解析订单 JSON
    const order = JSON.parse(rawBody);
    const orderId = order.id.toString();   // 建议统一转成字符串

    // ---------- ① 写入 orders 表 ----------
    const orderPayload = {
      order_id:           orderId,
      order_number:       order.name,                     // "#S1001"
      created_at:         order.created_at,               // ISO 时间
      customer:           `${order.customer?.first_name ?? ""} ${order.customer?.last_name ?? ""}`.trim(),
      shipping_name:      order.shipping_address?.name ?? "",
      shipping_phone:     order.shipping_address?.phone ?? "",
      shipping_country:   order.shipping_address?.country_code ?? "",
      fulfillment_status: order.fulfillment_status,
      financial_status:   order.financial_status,
      cancelled_at:       order.cancelled_at
    };
    await insertIntoSupabase("orders", orderPayload, env);

    // ---------- ② 写入 order_items 表 ----------
    const promises = (order.line_items || []).map(item => {
      const itemPayload = {
        order_id:   orderId,                  // 外键
        title:      item.title,
        sim_type:   (order.note_attributes || []).find(n => n.name === "Physical SIM / eSIM")?.value ?? "",
        sim_number: "",                       // 如果有发货后写入
        quantity:   item.quantity,
        activation_plan: (item.properties || []).find(p => p.name === "Activation Plan")?.value ?? ""
      };
      return insertIntoSupabase("order_items", itemPayload, env);
    });
    await Promise.all(promises);

    return new Response("OK", { status: 200 });
  }
}
