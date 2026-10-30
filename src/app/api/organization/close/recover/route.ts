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
    // Local Next.js development uses .env.local.
  }

  return env;
}

function isMissingAuthUser(
  error: { message?: string; code?: string } | null
) {
  if (!error) return false;

  return (
    error.code === "user_not_found" ||
    /not found|does not exist|user_not_found/i.test(error.message ?? "")
  );
}

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const accessToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!accessToken) {
    return NextResponse.json(
      { error: "Oturum doğrulanamadı." },
      { status: 401 }
    );
  }

  let body: { organizationId?: string; confirmation?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Geçersiz istek." },
      { status: 400 }
    );
  }

  const organizationId = body.organizationId;

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!organizationId || !uuidPattern.test(organizationId)) {
    return NextResponse.json(
      { error: "Geçerli işletme kimliği gerekli." },
      { status: 400 }
    );
  }

  if (body.confirmation !== "CLOSE_ORGANIZATION") {
    return NextResponse.json(
      { error: "İşletme kapatma onayı eksik." },
      { status: 400 }
    );
  }

  const env = await getServerEnv();

  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = env.SUPABASE_SECRET_KEY;

  if (!url || !publishableKey || !secretKey) {
    return NextResponse.json(
      { error: "Sunucu ayarları eksik." },
      { status: 500 }
    );
  }

  const authClient = createClient(url, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

  const admin = createClient(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: authData, error: authError } =
    await authClient.auth.getUser(accessToken);

  if (authError || !authData.user) {
    return NextResponse.json(
      { error: "Oturum geçersiz." },
      { status: 401 }
    );
  }

  const ownerId = authData.user.id;

  const { data: initialJob, error: jobReadError } = await admin
    .from("organization_closure_jobs")
    .select(
      "id, organization_id, requested_by, user_ids, deleted_user_ids, status"
    )
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (jobReadError) {
    return NextResponse.json(
      { error: "Kapatma kaydı okunamadı." },
      { status: 500 }
    );
  }
  let job = initialJob;
  if (job && job.requested_by !== ownerId) {
    return NextResponse.json(
      { error: "Bu işletmeyi kapatma yetkiniz yok." },
      { status: 403 }
    );
  }

  if (!job) {
    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("id, owner_id, status")
      .eq("id", organizationId)
      .maybeSingle();

    if (orgError) {
      return NextResponse.json(
        { error: "İşletme bilgisi okunamadı." },
        { status: 500 }
      );
    }

    if (!org || org.owner_id !== ownerId) {
      return NextResponse.json(
        { error: "Bu işletmeyi kapatma yetkiniz yok." },
        { status: 403 }
      );
    }

    if (org.status !== "active" && org.status !== "closing") {
      return NextResponse.json(
        { error: "İşletme kapatma için uygun durumda değil." },
        { status: 409 }
      );
    }

    if (org.status === "active") {
      const { error } = await authClient.rpc(
        "depomap_begin_org_closure",
        {
          p_organization_id: organizationId,
        }
      );

      if (error) {
        return NextResponse.json(
          { error: "İşletme kapatma başlatılamadı." },
          { status: 400 }
        );
      }
    }

    const { data: jobId, error: createError } = await admin.rpc(
      "depomap_create_org_closure_job",
      {
        p_organization_id: organizationId,
        p_requested_by: ownerId,
      }
    );

    if (createError || !jobId) {
      return NextResponse.json(
        { error: "Kapatma işi oluşturulamadı." },
        { status: 500 }
      );
    }

    const { data: createdJob, error: createdJobError } = await admin
      .from("organization_closure_jobs")
      .select(
        "id, organization_id, requested_by, user_ids, deleted_user_ids, status"
      )
      .eq("id", jobId)
      .single();

    if (createdJobError || !createdJob) {
      return NextResponse.json(
        { error: "Kapatma işi okunamadı." },
        { status: 500 }
      );
    }

    job = createdJob;
  }

  if (job.status === "completed") {
    return NextResponse.json({
      success: true,
      message: "İşletme kapatma işlemi zaten tamamlanmış.",
    });
  }

  const lockToken = crypto.randomUUID();

  const { data: lockAcquired, error: lockError } = await admin.rpc(
    "depomap_acquire_closure_lock",
    {
      p_job_id: job.id,
      p_lock_token: lockToken,
    }
  );

  if (lockError) {
    return NextResponse.json(
      { error: "Kapatma işlemi kilitlenemedi." },
      { status: 500 }
    );
  }

  if (!lockAcquired) {
    return NextResponse.json(
      {
        error:
          "Başka bir kapatma işlemi devam ediyor. Biraz sonra tekrar deneyin.",
      },
      { status: 409 }
    );
  }

  const renewLock = async () => {
    const { data, error } = await admin.rpc(
      "depomap_renew_closure_lock",
      {
        p_job_id: job!.id,
        p_lock_token: lockToken,
      }
    );

    if (error || !data) {
      throw new Error(
        error?.message || "İşlem kilidi yenilenemedi."
      );
    }
  };

  const saveProgress = async (deletedIds: Set<string>) => {
    const { data, error } = await admin
      .from("organization_closure_jobs")
      .update({
        deleted_user_ids: Array.from(deletedIds),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job!.id)
      .eq("lock_token", lockToken)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      throw new Error(
        error?.message || "Kapatma ilerlemesi kaydedilemedi."
      );
    }
  };

  const deleteAccount = async (
    userId: string,
    deletedIds: Set<string>
  ) => {
    await renewLock();

    // Remove application-level references before deleting the Supabase Auth user.
    const { error: cleanupError } = await admin.rpc(
      "depomap_prepare_account_deletion",
      {
        p_user_id: userId,
      }
    );

    if (cleanupError) {
      throw new Error(
        `Hesap ilişkili kayıtları temizlenemedi: ${cleanupError.message}`
      );
    }

    const { error: deleteError } =
      await admin.auth.admin.deleteUser(userId);

    if (deleteError && !isMissingAuthUser(deleteError)) {
      throw new Error(
        `Supabase kullanıcı hesabı silinemedi: ${deleteError.message}`
      );
    }

    deletedIds.add(userId);
    await saveProgress(deletedIds);
  };

  try {
    const { data: freshJob, error: freshJobError } = await admin
      .from("organization_closure_jobs")
      .select(
        "organization_id, requested_by, user_ids, deleted_user_ids, status"
      )
      .eq("id", job.id)
      .eq("lock_token", lockToken)
      .single();

    if (freshJobError || !freshJob) {
      throw new Error(
        freshJobError?.message || "Kapatma işi okunamadı."
      );
    }

    if (
      freshJob.requested_by !== ownerId ||
      freshJob.organization_id !== organizationId
    ) {
      throw new Error(
        "Kapatma işi sahiplik doğrulamasından geçemedi."
      );
    }

    if (freshJob.status === "completed") {
      return NextResponse.json({
        success: true,
        message: "İşletme kapatma işlemi zaten tamamlanmış.",
      });
    }

    const allUserIds = Array.from(
      new Set([...(freshJob.user_ids ?? []), ownerId])
    );

    const deleted = new Set<string>(
      freshJob.deleted_user_ids ?? []
    );

    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("id, owner_id, status")
      .eq("id", organizationId)
      .maybeSingle();

    if (orgError) {
      throw new Error(orgError.message);
    }

    if (
      org &&
      (org.owner_id !== ownerId || org.status !== "closing")
    ) {
      throw new Error(
        "İşletme sahipliği veya kapatma durumu doğrulanamadı."
      );
    }

    const { error: processingError } = await admin
      .from("organization_closure_jobs")
      .update({
        status: "processing",
        failed_user_ids: [],
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("lock_token", lockToken);

    if (processingError) {
      throw new Error(processingError.message);
    }

    // Delete the organization once. The closure job is deliberately independent and survives this cascade.
    if (org) {
      await renewLock();

      const { error: deleteOrgError } = await admin
        .from("organizations")
        .delete()
        .eq("id", organizationId)
        .eq("owner_id", ownerId);

      if (deleteOrgError) {
        throw new Error(
          `İşletme verileri silinemedi: ${deleteOrgError.message}`
        );
      }
    }

    const workers = allUserIds.filter(
      (id) => id !== ownerId
    );

    for (const userId of workers) {
      if (!deleted.has(userId)) {
        await deleteAccount(userId, deleted);
      }
    }

    // Delete the owner last so the request can finish while their access token is still valid.
    if (!deleted.has(ownerId)) {
      await deleteAccount(ownerId, deleted);
    }

    const { data: completed, error: completeError } = await admin
      .from("organization_closure_jobs")
      .update({
        deleted_user_ids: Array.from(deleted),
        failed_user_ids: [],
        status: "completed",
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("lock_token", lockToken)
      .select("id")
      .maybeSingle();

    if (completeError || !completed) {
      throw new Error(
        completeError?.message ||
          "Kapatma tamamlanma kaydı yazılamadı."
      );
    }

    return NextResponse.json({
      success: true,
      message:
        "İşletme, tüm işletme verileri ve bağlı kullanıcı hesapları kalıcı olarak silindi. Yeniden kayıt olunması gerekir.",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Bilinmeyen kapatma hatası.";

    await admin
      .from("organization_closure_jobs")
      .update({
        status: "failed",
        error_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("lock_token", lockToken);

    return NextResponse.json(
      {
        error:
          "İşletme kapatma tamamlanamadı. Güvenli kurtarma işlemi için kayıt oluşturuldu.",
      },
      { status: 500 }
    );
  } finally {
    await admin.rpc("depomap_release_closure_lock", {
      p_job_id: job.id,
      p_lock_token: lockToken,
    });
  }
}