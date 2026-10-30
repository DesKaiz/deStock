import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization") || "";
  const accessToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!accessToken) {
    return NextResponse.json({ error: "Oturum doğrulanamadı. Yeniden giriş yapın." }, { status: 401 });
  }

  let body: { confirmation?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Geçersiz istek." }, { status: 400 });
  }

  if (body.confirmation !== "DELETE_MY_ACCOUNT") {
    return NextResponse.json({ error: "Hesap silme onayı eksik." }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !publishableKey || !secretKey) {
    return NextResponse.json({ error: "Sunucu hesap silme ayarları eksik." }, { status: 500 });
  }

  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // İstemciden gelen user_id kullanılmaz; kimlik doğrulanmış access token'dan alınır.
  const { data: authData, error: authError } = await authClient.auth.getUser(accessToken);
  if (authError || !authData.user) {
    return NextResponse.json({ error: "Oturum geçersiz veya süresi dolmuş. Yeniden giriş yapın." }, { status: 401 });
  }

  const userId = authData.user.id;

  // Fonksiyon service_role dışında çağrılamaz. Sahiplik kontrolü ve kullanıcı bağlantılarının temizliği DB tarafında yapılır.
  const { error: cleanupError } = await adminClient.rpc("depomap_prepare_account_deletion", {
    p_user_id: userId,
  });

  if (cleanupError) {
    const isOwner = cleanupError.message.toLowerCase().includes("işletme sahipliğini devretmeden");
    return NextResponse.json(
      { error: cleanupError.message },
      { status: isOwner ? 409 : 400 },
    );
  }

  const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);
  if (deleteError) {
    return NextResponse.json(
      { error: `Kullanıcı hesabı silinemedi: ${deleteError.message}. Destek için yöneticiyle iletişime geçin.` },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
