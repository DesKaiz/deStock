
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization") || "";
  const accessToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!accessToken) {
    return NextResponse.json({ error: "Oturum doğrulanamadı." }, { status: 401 });
  }

  let body: { organizationId?: string; confirmation?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Geçersiz istek." }, { status: 400 });
  }

  const organizationId = body.organizationId;

  if (
    !organizationId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)
  ) {
    return NextResponse.json({ error: "Geçerli işletme kimliği gerekli." }, { status: 400 });
  }

  if (body.confirmation !== "CLOSE_ORGANIZATION") {
    return NextResponse.json({ error: "İşletme kapatma onayı eksik." }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !publishableKey || !secretKey) {
    return NextResponse.json({ error: "Sunucu ayarları eksik." }, { status: 500 });
  }

  const authClient = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const admin = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: authData, error: authError } =
    await authClient.auth.getUser(accessToken);

  if (authError || !authData.user) {
    return NextResponse.json({ error: "Oturum geçersiz." }, { status: 401 });
  }

  const ownerId = authData.user.id;

  const { data: existingJob, error: existingJobError } = await admin
    .from("organization_closure_jobs")
    .select("id, requested_by, user_ids, deleted_user_ids, status")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existingJobError) {
    return NextResponse.json({ error: existingJobError.message }, { status: 500 });
  }

  if (existingJob && existingJob.requested_by !== ownerId) {
    return NextResponse.json(
      { error: "Bu işletmeyi kapatma yetkiniz yok." },
      { status: 403 },
    );
  }

  let job = existingJob;

  if (!job) {
    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("id, owner_id, status")
      .eq("id", organizationId)
      .maybeSingle();

    if (orgError) {
      return NextResponse.json({ error: orgError.message }, { status: 500 });
    }

    if (!org || org.owner_id !== ownerId) {
      return NextResponse.json(
        { error: "Bu işletmeyi kapatma yetkiniz yok." },
        { status: 403 },
      );
    }

    if (org.status !== "active" && org.status !== "closing") {
      return NextResponse.json(
        { error: "İşletme kapatma için uygun durumda değil." },
        { status: 409 },
      );
    }

    if (org.status === "active") {
      const { error } = await authClient.rpc("depomap_begin_org_closure", {
        p_organization_id: organizationId,
      });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    const { data: jobId, error: createError } = await admin.rpc(
      "depomap_create_org_closure_job",
      {
        p_organization_id: organizationId,
        p_requested_by: ownerId,
      },
    );

    if (createError || !jobId) {
      return NextResponse.json(
        { error: createError?.message || "İş kaydı oluşturulamadı." },
        { status: 500 },
      );
    }

    const { data: newJob, error: readError } = await admin
      .from("organization_closure_jobs")
      .select("id, requested_by, user_ids, deleted_user_ids, status")
      .eq("id", jobId)
      .single();

    if (readError || !newJob) {
      return NextResponse.json(
        { error: "İş kaydı okunamadı." },
        { status: 500 },
      );
    }

    job = newJob;
  }

  if (job.status === "completed") {
    return NextResponse.json({
      success: true,
      message: "İşletme zaten kapatılmış.",
    });
  }

  const lockToken = crypto.randomUUID();

  const { data: lockAcquired, error: lockError } = await admin.rpc(
    "depomap_acquire_closure_lock",
    {
      p_job_id: job.id,
      p_lock_token: lockToken,
    },
  );

  if (lockError) {
    return NextResponse.json({ error: lockError.message }, { status: 500 });
  }

  if (!lockAcquired) {
    return NextResponse.json(
      { error: "Başka bir kapatma işlemi devam ediyor. Biraz sonra tekrar deneyin." },
      { status: 409 },
    );
  }

  try {
    const renewLock = async () => {
      const { data, error } = await admin.rpc(
        "depomap_renew_closure_lock",
        {
          p_job_id: job.id,
          p_lock_token: lockToken,
        },
      );

      if (error || !data) {
        throw new Error(
          error?.message || "İşlem kilidi yenilenemedi. Güvenlik için işlem durduruldu.",
        );
      }
    };

    const { data: freshJob, error: freshJobError } = await admin
      .from("organization_closure_jobs")
      .select("user_ids, deleted_user_ids, status")
      .eq("id", job.id)
      .eq("lock_token", lockToken)
      .single();

    if (freshJobError || !freshJob) {
      throw new Error(freshJobError?.message || "İş kaydı okunamadı.");
    }

    if (freshJob.status === "completed") {
      return NextResponse.json({
        success: true,
        message: "İşletme zaten kapatılmış.",
      });
    }

    const userIds = freshJob.user_ids as string[];
    const deleted = new Set<string>(freshJob.deleted_user_ids || []);

    const { data: org, error: orgReadError } = await admin
      .from("organizations")
      .select("id, owner_id, status")
      .eq("id", organizationId)
      .maybeSingle();

    if (orgReadError) throw new Error(orgReadError.message);

    if (org) {
      if (org.owner_id !== ownerId || org.status !== "closing") {
        throw new Error("İşletme kapatma durumu doğrulanamadı.");
      }

      await renewLock();

      const { error: deleteOrgError } = await admin
        .from("organizations")
        .delete()
        .eq("id", organizationId)
        .eq("owner_id", ownerId);

      if (deleteOrgError) throw new Error(deleteOrgError.message);
    }

    const { data: processingJob, error: processingError } = await admin
      .from("organization_closure_jobs")
      .update({
        status: "processing",
        failed_user_ids: [],
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("lock_token", lockToken)
      .select("id")
      .maybeSingle();

    if (processingError || !processingJob) {
      throw new Error(processingError?.message || "İşlem kilidi kaybedildi.");
    }

    const workers = userIds.filter((id) => id !== ownerId);

    for (const userId of workers) {
      if (deleted.has(userId)) continue;

      await renewLock();

      const { error } = await admin.auth.admin.deleteUser(userId);

      if (error && !/not found|does not exist|user_not_found/i.test(error.message)) {
        await admin
          .from("organization_closure_jobs")
          .update({
            status: "failed",
            failed_user_ids: [
              ...workers.filter((id) => !deleted.has(id)),
              ownerId,
            ],
            error_message: error.message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("lock_token", lockToken);

        return NextResponse.json(
          {
            error: "Bir çalışan hesabı silinemedi. Yeniden deneyerek devam edebilirsiniz.",
          },
          { status: 500 },
        );
      }

      deleted.add(userId);

      const { data: progressJob, error: progressError } = await admin
        .from("organization_closure_jobs")
        .update({
          deleted_user_ids: Array.from(deleted),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("lock_token", lockToken)
        .select("id")
        .maybeSingle();

      if (progressError || !progressJob) {
        throw new Error(progressError?.message || "İşlem kilidi kaybedildi.");
      }
    }

    if (!deleted.has(ownerId)) {
      await renewLock();

      const { error } = await admin.auth.admin.deleteUser(ownerId);

      if (error && !/not found|does not exist|user_not_found/i.test(error.message)) {
        await admin
          .from("organization_closure_jobs")
          .update({
            status: "failed",
            failed_user_ids: [ownerId],
            error_message: error.message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("lock_token", lockToken);

        return NextResponse.json(
          { error: "İşletme sahibi hesabı silinemedi." },
          { status: 500 },
        );
      }

      deleted.add(ownerId);
    }

    const { data: completedJob, error: completeError } = await admin
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

    if (completeError || !completedJob) {
      throw new Error(completeError?.message || "İşlem kilidi kaybedildi.");
    }

    return NextResponse.json({
      success: true,
      message: "İşletme ve bağlı kullanıcı hesapları silindi.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen hata.";

    await admin
      .from("organization_closure_jobs")
      .update({
        status: "failed",
        error_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("lock_token", lockToken);

    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await admin.rpc("depomap_release_closure_lock", {
      p_job_id: job.id,
      p_lock_token: lockToken,
    });
  }
}
