const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  // Stripe firma el webhook; si no validas firma, cualquiera te “regala PRO”.
  const sig = event.headers["stripe-signature"];
  if (!sig) return { statusCode: 400, body: "Missing stripe-signature header" };

  let stripeEvent;

  try {
    // Netlify a veces manda body en base64
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;

    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return { statusCode: 400, body: `Webhook signature failed: ${err.message}` };
  }

  try {
    const type = stripeEvent.type;
    const obj = stripeEvent.data.object;

    // Helper: upsert por email (checkout) o por customer_id (updates)
    const setProByEmail = async ({ email, pro, customerId, subscriptionId }) => {
      if (!email) return;

      const { error } = await supabase.from("profiles").upsert(
        {
          email,
          pro,
          stripe_customer_id: customerId || null,
          stripe_subscription_id: subscriptionId || null,
          pro_updated_at: new Date().toISOString(),
        },
        { onConflict: "email" }
      );

      if (error) throw error;
    };

    const setProByCustomerId = async ({ customerId, pro, subscriptionId }) => {
      if (!customerId) return;

      const { error } = await supabase
        .from("profiles")
        .update({
          pro,
          stripe_subscription_id: subscriptionId || null,
          pro_updated_at: new Date().toISOString(),
        })
        .eq("stripe_customer_id", customerId);

      if (error) throw error;
    };

    // 1) Cuando el pago/checkout de suscripción se completa (Payment Link usa Checkout)
    if (type === "checkout.session.completed") {
      const email = obj.customer_details?.email || obj.customer_email;
      const customerId = obj.customer; // cus_...
      const subscriptionId = obj.subscription; // sub_...

      // PRO ON
      await setProByEmail({
        email,
        pro: true,
        customerId,
        subscriptionId,
      });
    }

    // 2) Cuando la suscripción cambia (renovación, pausa, cancelación programada, etc.)
    if (type === "customer.subscription.updated") {
      const customerId = obj.customer; // cus_...
      const subscriptionId = obj.id; // sub_...
      const status = obj.status; // active, trialing, past_due, canceled...

      const pro = status === "active" || status === "trialing";
      await setProByCustomerId({ customerId, pro, subscriptionId });
    }

    // 3) Cuando la suscripción se elimina/cancela definitivamente
    if (type === "customer.subscription.deleted") {
      const customerId = obj.customer;
      const subscriptionId = obj.id;

      // PRO OFF
      await setProByCustomerId({ customerId, pro: false, subscriptionId });
    }

    // (Opcional) Si un pago falla y quieres cortar PRO:
    // if (type === "invoice.payment_failed") { ... }

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    return { statusCode: 500, body: `Webhook handler failed: ${err.message}` };
  }
};

