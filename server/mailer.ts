import nodemailer from "nodemailer";

export class MailConfigurationError extends Error {
  constructor() {
    super("Email delivery is not configured. Set the SMTP environment variables.");
    this.name = "MailConfigurationError";
  }
}

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT);
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM;

  if (!host || !Number.isInteger(port) || !user || !password || !from) {
    throw new MailConfigurationError();
  }

  return {
    transport: nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass: password },
    }),
    from,
  };
}

export async function verifyEmailDelivery(): Promise<void> {
  const { transport } = createTransport();
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendAccountEmail(
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const { transport, from } = createTransport();
  try {
    await transport.sendMail({ from, to, subject, text });
  } finally {
    transport.close();
  }
}
