const express = require("express");
const app = express();
const path = require("path");

// Copy the .env.example in the root into a .env file in this folder
const envFilePath = path.resolve(__dirname, "../.env");
const env = require("dotenv").config({ path: envFilePath });
if (env.error) {
  throw new Error(
    `Unable to load the .env file from ${envFilePath}. Please copy .env.example to ${envFilePath}`
  );
}

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.use(express.static(process.env.STATIC_DIR));
app.use(
  express.json({
    // We need the raw body to verify webhook signatures.
    // Let's compute it only when hitting the Stripe webhook endpoint.
    verify: function (req, res, buf) {
      if (req.originalUrl.startsWith("/webhook")) {
        req.rawBody = buf.toString();
      }
    }
  })
);

app.get("/", (req, res) => {
  const filePath = path.resolve(process.env.STATIC_DIR + "/index.html");
  res.sendFile(filePath);
});

// Fetch the Checkout Session to display the JSON result on the success page
app.get("/checkout-session", async (req, res) => {
  const { sessionId } = req.query;
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  console.log(sessionId);

  const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent);

  console.log(session);
  console.log(setupIntent);

  const firstPayment = await stripe.paymentIntents.create({
    amount: 124800,
    currency: "sgd",
    customer: session.customer,
    payment_method: setupIntent.payment_method,
    off_session: true,
    capture_method: "manual",
    confirm: true
  });

  console.log(firstPayment);

  const paymentMethod = await stripe.paymentMethods.create(
    {
      customer: session.customer,
      payment_method: firstPayment.payment_method
    },
    { stripeAccount: "acct_1ITNZAL7OQQcllx3" }
  );

  const secondPayment = await stripe.paymentIntents.create(
    {
      amount: 15200,
      currency: "sgd",
      payment_method: paymentMethod.id,
      off_session: true,
      capture_method: "manual",
      confirm: true
    },
    { stripeAccount: "acct_1ITNZAL7OQQcllx3" }
  );

  console.log(secondPayment);

  if (
    firstPayment.status !== "requires_capture" ||
    secondPayment.status !== "requires_capture"
  ) {
    // One of the paymentmethods failed, cancel both payment intents
    await stripe.paymentIntents.cancel(firstPayment.id);
    await stripe.paymentIntents.cancel(secondPayment.id);

    return;
  }

  const fpCapture = await stripe.paymentIntents.capture(firstPayment.id);
  const spCapture = await stripe.paymentIntents.capture(secondPayment.id, {
    stripeAccount: "acct_1ITNZAL7OQQcllx3"
  });

  console.log(fpCapture);
  console.log(spCapture);

  if (fpCapture.status !== "succeeded" || spCapture.status !== "succeeded") {
    // This should never happen unless Stripe is somehow down, but just double check and error handle.
    // some error handling here.
    console.log("handle uncaptured");
    return;
  }

  const t1 = await stripe.transfers.create({
    amount: 500,
    currency: "sgd",
    destination: "acct_1IThMsJ5sb1tuACQ",
    source_transaction: fpCapture.charges.data[0].id
  });

  console.log(t1);

  const t2 = await stripe.transfers.create({
    amount: 700,
    currency: "sgd",
    destination: "acct_1IThUbH32nEnwWw8",
    source_transaction: fpCapture.charges.data[0].id
  });

  console.log(t2);

  res.send(session);
});

app.post("/create-checkout-session", async (req, res) => {
  const domainURL = process.env.DOMAIN;

  // Create new Checkout Session for the order
  // Other optional params include:
  // [billing_address_collection] - to display billing address details on the page
  // [customer] - if you have an existing Stripe Customer ID
  // [customer_email] - lets you prefill the email input in the form
  // For full details see https://stripe.com/docs/api/checkout/sessions/create
  try {
    const cust = await stripe.customers.create();
    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      payment_method_types: ["card"],
      customer: cust.id,
      success_url: `${domainURL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domainURL}/canceled.html`
    });

    res.send({
      sessionId: session.id
    });
  } catch (e) {
    res.status(400);
    return res.send({
      error: {
        message: e.message
      }
    });
  }
});

app.get("/setup", (req, res) => {
  res.send({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    basicPrice: process.env.BASIC_PRICE_ID,
    proPrice: process.env.PRO_PRICE_ID
  });
});

app.post("/customer-portal", async (req, res) => {
  // For demonstration purposes, we're using the Checkout session to retrieve the customer ID.
  // Typically this is stored alongside the authenticated user in your database.
  const { sessionId } = req.body;
  const checkoutsession = await stripe.checkout.sessions.retrieve(sessionId);

  // This is the url to which the customer will be redirected when they are done
  // managing their billing with the portal.
  const returnUrl = process.env.DOMAIN;

  const portalsession = await stripe.billingPortal.sessions.create({
    customer: checkoutsession.customer,
    return_url: returnUrl
  });

  res.send({
    url: portalsession.url
  });
});

// Webhook handler for asynchronous events.
app.post("/webhook", async (req, res) => {
  let eventType;
  let data;

  // Check if webhook signing is configured.
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    // Retrieve the event by verifying the signature using the raw body and secret.
    let event;
    let signature = req.headers["stripe-signature"];

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log(`⚠️  Webhook signature verification failed.`);
      return res.sendStatus(400);
    }
    // Extract the object from the event.
    data = event.data;
    eventType = event.type;

    console.log("WEBHOOK RECEIVED");
    console.log(eventType);
    console.log(data);
  } else {
    // Webhook signing is recommended, but if the secret is not configured in `config.js`,
    // retrieve the event data directly from the request body.
    data = req.body.data;
    eventType = req.body.type;
  }

  if (eventType === "checkout.session.completed") {
    console.log(`🔔  Payment received!`);
  }

  res.sendStatus(200);
});

app.listen(8080, () =>
  console.log(`Node server listening at http://localhost:${8080}/`)
);
