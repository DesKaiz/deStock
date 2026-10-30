import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

async function getServerEnv(): Promise<Record<string, string | undefined>> {
  let env: Record<string, string | undefined> = process.env;

  try {
    const context = await getCloudflareContext();
    env = context.env as Record<string, string | undefined>;
  } catch {
    // Yerel Next.js geliştirme ortamında .env.local kullanılır.
  }

  return env;
}

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization") || "";

  const accessToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!accessToken) {
    return NextResponse.json(
      {
        error: "Oturum doğrulanamadı. Yeniden giriş yapın.",
      },
      { status: 401 },
    );
  }

  let body: { confirmation?: string } = {};

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Geçersiz istek." },
      { status: 400 },
    );
  }

  if (body.confirmation !== "DELETE_MY_ACCOUNT") {
    return NextResponse.json(
      { error: "Hesap silme onayı eksik." },
      { status: 400 },
    );
  }

  const env = await getServerEnv();

  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !publishableKey || !secretKey) {
    return NextResponse.json(
      { error: "Sunucu hesap silme ayarları eksik." },
      { status: 500 },
    );
  }

  const authClient = createClient(
    supabaseUrl,
    publishableKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  const adminClient = createClient(
    supabaseUrl,
    secretKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  // Kullanıcı kimliği doğrulanmış oturumdan alınır.
  const { data: authData, error: authError } =
    await authClient.auth.getUser(accessToken);

  if (authError || !authData.user) {
    return NextResponse.json(
      {
        error:
          "Oturum geçersiz veya süresi dolmuş. Yeniden giriş yapın.",
      },
      { status: 401 },
    );
  }

  const userId = authData.user.id;

  // Hesap silinmeden önce uygulama kayıtları temizlenir.
  const { error: cleanupError } = await adminClient.rpc(
    "depomap_prepare_account_deletion",
    {
      p_user_id: userId,
    },
  );

  if (cleanupError) {
    const isOwner = cleanupError.message
      .toLowerCase()
      .includes("işletme sahipliğini devretmeden");

    return NextResponse.json(
      {
        error: cleanupError.message,
      },
      {
        status: isOwner ? 409 : 400,
      },
    );
  }

  // Supabase Auth hesabı kalıcı olarak silinir.
  const { error: deleteError } =
    await adminClient.auth.admin.deleteUser(userId);

  if (deleteError) {
    return NextResponse.json(
      {
        error: `Kullanıcı hesabı silinemedi: ${deleteError.message}`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    message: "Hesabınız kalıcı olarak silindi.",
  });
}