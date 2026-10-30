"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { Stage, Layer, Rect, Text, Group, Line } from "react-konva";
import type { MapObject, MapObjectType, ProductEntry } from "@/types/warehouse";
import { OBJECT_COLORS } from "@/types/warehouse";

const SCALE = 42;
const initialObjects: MapObject[] = [
  { id: "pallet-1", type: "pallet", label: "Palet P-001", x: 1, y: 1, width: 1.2, length: 1.0, rotation: 0,
    products: [{ id: "prod-1", name: "Kakaolu kek", quantity: 12, unit: "adet" }, { id: "prod-2", name: "Kraker", quantity: null, unit: "adet" }] },
  { id: "rack-1", type: "rack", label: "Raf 1", x: 4, y: 1, width: 2.0, length: 1.0, rotation: 0, products: [] },
  { id: "cart-1", type: "cart", label: "Araba A-01", x: 1, y: 4, width: 0.8, length: 0.6, rotation: 0, products: [] }
];

function makeId() {
  // Supabase UUID alanları için her koşulda geçerli UUID üret.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
  }

  // Eski tarayıcılar için RFC 4122 v4 biçiminde yedek üretim.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

const isCloudConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
);

type DbWarehouse = {
  id: string;
  name: string;
  width_m: number | string;
  length_m: number | string;
  grid_size_m: number | string;
};

type DbStorageUnit = {
  id: string;
  map_object_id: string | null;
  unit_type: string;
  label: string;
};

type DbStorageContent = {
  storage_unit_id: string;
  product_id: string;
  quantity: number | null;
};

type DbProduct = {
  id: string;
  name: string;
  unit_name: string | null;
};

type DbMapObject = {
  id: string;
  object_type: string;
  label: string;
  x_m: number | string;
  y_m: number | string;
  width_m: number | string;
  length_m: number | string;
  rotation_deg: number | string;
};

type CreatedOrganization = {
  organization_id?: string;
  warehouse_id?: string;
};

type WarehousePatch = {
  name?: string;
  width_m?: number;
  length_m?: number;
  grid_size_m?: number;
};

type ActivityLog = {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
};

export default function WarehouseApp() {
  const supabase = useMemo(() => (isCloudConfigured ? createClient() : null), []);
  const [user, setUser] = useState<{ id: string; email?: string; username?: string; inviteCode?: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(Boolean(isCloudConfigured));
  const [authBusy, setAuthBusy] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [createdInviteCode, setCreatedInviteCode] = useState("");
  const [inviteCodeBusy, setInviteCodeBusy] = useState(false);
  const [inviteCodeMessage, setInviteCodeMessage] = useState("");
  const [teamMembers, setTeamMembers] = useState<Array<{ user_id: string; email: string | null; role: string; joined_at: string | null }>>([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamMessage, setTeamMessage] = useState("");
  const [accountDeleteStep, setAccountDeleteStep] = useState<0 | 1 | 2>(0);
  const [accountDeleteBusy, setAccountDeleteBusy] = useState(false);
  const [accountDeleteError, setAccountDeleteError] = useState("");
  const [organizationCloseStep, setOrganizationCloseStep] = useState<0 | 1 | 2>(0);
  const [organizationCloseBusy, setOrganizationCloseBusy] = useState(false);
  const [organizationCloseError, setOrganizationCloseError] = useState("");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [mapZoom, setMapZoom] = useState(1);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const panGesture = useRef<{ kind: "mouse" | "touch" | null; lastX: number; lastY: number; lastDistance: number }>({ kind: null, lastX: 0, lastY: 0, lastDistance: 0 });
  const [isSettingPassword, setIsSettingPassword] = useState(false);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [membershipRole, setMembershipRole] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [storageUnitIds, setStorageUnitIds] = useState<Record<string, string>>({});
  const [dataError, setDataError] = useState<string | null>(null);
  const [warehouseName, setWarehouseName] = useState("Ana Depo");
  const [widthM, setWidthM] = useState(12);
  const [lengthM, setLengthM] = useState(8);
  const [gridM, setGridM] = useState(0.5);
  const [objects, setObjects] = useState<MapObject[]>(isCloudConfigured ? [] : initialObjects);
  const [selectedId, setSelectedId] = useState<string | null>(isCloudConfigured ? null : "pallet-1");
  const [search, setSearch] = useState("");
  const [productName, setProductName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unknownQuantity, setUnknownQuantity] = useState(false);
  const [notice, setNotice] = useState(isCloudConfigured ? "Hesap bağlantısı bekleniyor." : "Yerel demo modu: değişiklikler buluta kaydedilmiyor.");
  const [showAllProducts, setShowAllProducts] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [activityUserSearch, setActivityUserSearch] = useState("");
  const [activityProductSearch, setActivityProductSearch] = useState("");
  const [activityActionFilter, setActivityActionFilter] = useState("all");
  const [activityDateFrom, setActivityDateFrom] = useState("");
  const [activityDateTo, setActivityDateTo] = useState("");
  const canManageWarehouse = !isCloudConfigured || ["owner", "manager"].includes(membershipRole ?? "");
  const canEditOperations = !isCloudConfigured || ["owner", "manager", "worker"].includes(membershipRole ?? "");

  const loadTeamMembers = useCallback(async (orgId: string) => {
    if (!supabase) return;
    setTeamLoading(true);
    setTeamMessage("");
    try {
      const { data, error } = await supabase.rpc("depomap_list_members", {
        p_organization_id: orgId,
      });
      if (error) throw error;
      setTeamMembers((data ?? []) as Array<{ user_id: string; email: string | null; role: string; joined_at: string | null }>);
    } catch (error) {
      setTeamMessage(error instanceof Error ? error.message : "Ekip listesi yüklenemedi.");
    } finally {
      setTeamLoading(false);
    }
  }, [supabase]);

// Oturum bilgisini al ve giriş/çıkış değişikliklerini dinle.
useEffect(() => {
  if (!supabase) return;

  let alive = true;

  supabase.auth.getSession().then(({ data, error }) => {
    if (!alive) return;

    if (error) setDataError(error.message);

    const session = data.session;

    if (session?.user) {
      setUser({
        id: session.user.id,
        email: session.user.email,
        username: typeof session.user.user_metadata?.username === "string" ? session.user.user_metadata.username : typeof session.user.user_metadata?.display_name === "string" ? session.user.user_metadata.display_name : undefined,
        inviteCode: typeof session.user.user_metadata?.depomap_invite_code === "string" ? session.user.user_metadata.depomap_invite_code : undefined,
      });

      if (
        session.user.invited_at &&
        !session.user.user_metadata?.password_set
      ) {
        setIsSettingPassword(true);
      }
    } else {
      setUser(null);
    }

    setAuthLoading(false);
  });

  const { data: authListener } = supabase.auth.onAuthStateChange(
    (event, session) => {
      if (!alive) return;

      setUser(
        session?.user
          ? {
              id: session.user.id,
              email: session.user.email,
              username: typeof session.user.user_metadata?.username === "string" ? session.user.user_metadata.username : typeof session.user.user_metadata?.display_name === "string" ? session.user.user_metadata.display_name : undefined,
              inviteCode: typeof session.user.user_metadata?.depomap_invite_code === "string" ? session.user.user_metadata.depomap_invite_code : undefined,
            }
          : null
      );

      if (event === "PASSWORD_RECOVERY") {
  setIsSettingPassword(true);
}

if (event === "USER_UPDATED" && session?.user.user_metadata?.password_set) {
  setIsSettingPassword(false);
}

      setAuthLoading(false);
    }
  );

  return () => {
    alive = false;
    authListener.subscription.unsubscribe();
  };
}, [supabase]);

  // Kullanıcının organizasyonunu, deposunu ve harita/ürün verilerini yükle.
  useEffect(() => {
    if (!supabase || !user) {
      setOrganizationId(null);
      setWarehouseId(null);
      setStorageUnitIds({});
      if (isCloudConfigured && !user) {
        setObjects([]);
        setSelectedId(null);
      }
      return;
    }

    let alive = true;
    let channel: RealtimeChannel | null = null;

    async function loadWarehouseData(orgId: string, whId: string) {
      const [warehouseResult, objectsResult, unitsResult, contentsResult, productsResult] = await Promise.all([
        supabase!.from("warehouses").select("id,name,width_m,length_m,grid_size_m").eq("id", whId).eq("organization_id", orgId).single(),
        supabase!.from("map_objects").select("id,object_type,label,x_m,y_m,width_m,length_m,rotation_deg").eq("warehouse_id", whId).eq("organization_id", orgId),
        supabase!.from("storage_units").select("id,map_object_id,unit_type,label").eq("warehouse_id", whId).eq("organization_id", orgId),
        supabase!.from("storage_contents").select("storage_unit_id,product_id,quantity").eq("warehouse_id", whId).eq("organization_id", orgId),
        supabase!.from("products").select("id,name,unit_name").eq("organization_id", orgId)
      ]);

      const firstError = warehouseResult.error || objectsResult.error || unitsResult.error || contentsResult.error || productsResult.error;
      if (firstError) throw firstError;

      const warehouse = warehouseResult.data as DbWarehouse;
      const unitRows = (unitsResult.data ?? []) as DbStorageUnit[];
      const productRows = (productsResult.data ?? []) as DbProduct[];
      const contentRows = (contentsResult.data ?? []) as DbStorageContent[];
      const objectRows = (objectsResult.data ?? []) as DbMapObject[];
      const contentsByUnit = new Map<string, Array<{ id: string; name: string; quantity: number | null; unit: string }>>();
      const productById = new Map<string, DbProduct>(productRows.map((product) => [product.id, product]));
      for (const content of contentRows) {
        const product = productById.get(content.product_id);
        if (!product) continue;
        // Stok miktarı sıfır olan ürünler kayıtta kalır ancak aktif listelerde gösterilmez.
        if (content.quantity !== null && Number(content.quantity) <= 0) continue;
        const current = contentsByUnit.get(content.storage_unit_id) ?? [];
        current.push({
          id: product.id,
          name: product.name,
          quantity: content.quantity === null ? null : Number(content.quantity),
          unit: product.unit_name || "adet"
        });
        contentsByUnit.set(content.storage_unit_id, current);
      }

      const unitIdByObject: Record<string, string> = {};
      for (const unit of unitRows) {
        if (unit.map_object_id) unitIdByObject[unit.map_object_id] = unit.id;
      }
      const unitIdByObjectReverse = new Map<string, string>(Object.entries(unitIdByObject));
      const loadedObjects: MapObject[] = objectRows.map((row) => {
        const unitId = unitIdByObjectReverse.get(row.id);
        return {
          id: row.id,
          type: row.object_type as MapObjectType,
          label: row.label,
          x: Number(row.x_m),
          y: Number(row.y_m),
          width: Number(row.width_m),
          length: Number(row.length_m),
          rotation: Number(row.rotation_deg),
          products: unitId ? (contentsByUnit.get(unitId) ?? []) : []
        };
      });

      if (!alive) return;
      setWarehouseName(warehouse.name);
      setWidthM(Number(warehouse.width_m));
      setLengthM(Number(warehouse.length_m));
      setGridM(Number(warehouse.grid_size_m));
      setStorageUnitIds(unitIdByObject);
      setObjects(loadedObjects);
      setSelectedId((current) => current && loadedObjects.some((o) => o.id === current) ? current : (loadedObjects[0]?.id ?? null));
      setDataError(null);
    }

    async function initialize() {
      setDataError(null);
      try {
        // Davet kodu varsa önce kodu kullan; üyelik bundan sonra kalıcıdır.
        if (user!.inviteCode) {
          const { error: redeemError } = await supabase!.rpc("depomap_redeem_invite_code", {
            p_code: user!.inviteCode,
          });
          if (redeemError && !redeemError.message.toLocaleLowerCase("tr").includes("zaten üyesiniz")) {
            throw redeemError;
          }
          await supabase!.auth.updateUser({ data: { depomap_invite_code: null } });
        }

        const { data: membership, error: membershipError } = await supabase!
          .from("memberships")
          .select("organization_id,role")
          .eq("user_id", user!.id)
          .limit(1)
          .maybeSingle();
        if (membershipError) throw membershipError;
        setMembershipRole(membership?.role ?? "owner");

        let orgId = membership?.organization_id as string | undefined;
        let whId: string | undefined;

        if (!orgId) {
          const { data: created, error: createError } = await supabase!.rpc("depomap_create_organization", {
            p_organization_name: `${user!.email?.split("@")[0] || "Yeni"} organizasyonu`,
            p_warehouse_name: "Ana Depo",
            p_width_m: 12,
            p_length_m: 8,
            p_grid_size_m: 0.5
          });
          if (createError) throw createError;
          const createdRow = (Array.isArray(created) ? created[0] : created) as CreatedOrganization | null;
          orgId = createdRow?.organization_id;
          whId = createdRow?.warehouse_id;
          if (!orgId || !whId) throw new Error("Organizasyon oluşturuldu ancak depo kimliği alınamadı.");
        }

        if (!whId) {
          const { data: existingWarehouse, error: warehouseError } = await supabase!
            .from("warehouses")
            .select("id")
            .eq("organization_id", orgId!)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
          if (warehouseError) throw warehouseError;
          whId = existingWarehouse?.id;
        }

        if (!whId) {
          const { data: newWarehouse, error: insertWarehouseError } = await supabase!
            .from("warehouses")
            .insert({ organization_id: orgId!, name: "Ana Depo", width_m: 12, length_m: 8, grid_size_m: 0.5 })
            .select("id")
            .single();
          if (insertWarehouseError) throw insertWarehouseError;
          whId = newWarehouse.id;
        }

        if (!alive) return;
        setOrganizationId(orgId!);
        setWarehouseId(whId!);
        if (["owner", "manager"].includes(membership?.role ?? "owner")) {
          await loadTeamMembers(orgId!);
        }
        await loadWarehouseData(orgId!, whId!);

        if (!alive) return;

        channel = supabase!.channel(`depomap-${orgId}-${whId}`)

        channel = supabase!.channel(`depomap-${orgId}-${whId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "map_objects", filter: `warehouse_id=eq.${whId}` }, () => { void loadWarehouseData(orgId!, whId!); })
          .on("postgres_changes", { event: "*", schema: "public", table: "storage_units", filter: `warehouse_id=eq.${whId}` }, () => { void loadWarehouseData(orgId!, whId!); })
          .on("postgres_changes", { event: "*", schema: "public", table: "storage_contents", filter: `warehouse_id=eq.${whId}` }, () => { void loadWarehouseData(orgId!, whId!); })
          .on("postgres_changes", { event: "*", schema: "public", table: "products", filter: `organization_id=eq.${orgId}` }, () => { void loadWarehouseData(orgId!, whId!); })
          .on("postgres_changes", { event: "*", schema: "public", table: "warehouses", filter: `id=eq.${whId}` }, () => { void loadWarehouseData(orgId!, whId!); })
          .subscribe((status) => {
            if (alive && status === "SUBSCRIBED") setNotice("Bulut bağlantısı aktif. Değişiklikler kaydediliyor.");
          });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bilinmeyen bağlantı hatası.";
        if (alive) {
          setDataError(message);
          setNotice(`Bulut verileri yüklenemedi: ${message}`);
        }
      }
    }

    void initialize();
    return () => {
      alive = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase, user, loadTeamMembers]);

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!supabase) return;

    setAuthBusy(true);
    setDataError(null);

    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: {
            data: inviteCodeInput.trim()
              ? { depomap_invite_code: inviteCodeInput.trim().toUpperCase() }
              : {},
          },
        });

        if (error) throw error;

        if (!data.session) {
          setNotice(
            inviteCodeInput.trim()
              ? "Hesap oluşturuldu. E-posta doğrulamasından sonra davet kodun otomatik işlenecek."
              : "Hesap oluşturuldu. E-posta doğrulaması gerekiyorsa gelen kutunu kontrol et."
          );
        } else {
          setNotice(inviteCodeInput.trim() ? "Davet kodu kontrol ediliyor ve depoya katılım hazırlanıyor." : "Hesap oluşturuldu. Depo hazırlanıyor.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });

        if (error) throw error;

        setNotice("Giriş başarılı. Depo verileri yükleniyor.");
      }

      setPassword("");
      if (authMode === "signup") setInviteCodeInput("");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Kimlik doğrulama başarısız.";

      setDataError(message);
      setNotice(message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSetPassword(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();

  if (!supabase) return;

  setAuthBusy(true);
  setDataError(null);

  try {
    const { error } = await supabase.auth.updateUser({
  password,
  data: { password_set: true },
  });

    if (error) throw error;

    setPassword("");
    setIsSettingPassword(false);
    setNotice("Şifren başarıyla oluşturuldu. Depo yükleniyor.");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Şifre kaydedilemedi.";

    setDataError(message);
  } finally {
    setAuthBusy(false);
  }
}

  async function handleRemoveMember(member: { user_id: string; email: string | null; role: string }) {
    if (!supabase || !organizationId) return;
    const displayName = member.email || "Bu üye";
    if (!window.confirm(`${displayName} işletmeden çıkarılsın mı? Kişinin hesabı silinmez; yalnızca bu işletmeye erişimi kaldırılır.`)) return;
    setTeamMessage("");
    const { error } = await supabase.rpc("depomap_remove_member", {
      p_organization_id: organizationId,
      p_target_user_id: member.user_id,
    });
    if (error) {
      setTeamMessage(`Üye çıkarılamadı: ${error.message}`);
      return;
    }
    setTeamMembers((current) => current.filter((item) => item.user_id !== member.user_id));
    setTeamMessage(`${displayName} işletmeden çıkarıldı. Hesabı korunuyor.`);
  }

  async function handleCreateInviteCode() {
    if (!supabase || !organizationId || !["owner", "manager"].includes(membershipRole ?? "")) {
      setInviteCodeMessage("Davet kodu oluşturma yetkin yok.");
      return;
    }
    setInviteCodeBusy(true);
    setInviteCodeMessage("");
    setCreatedInviteCode("");
    try {
      const { data, error } = await supabase.rpc("depomap_create_invite_code", {
        p_organization_id: organizationId,
        p_role: "worker",
      });
      if (error) throw error;
      setCreatedInviteCode(String(data));
      setInviteCodeMessage("Kod 7 gün boyunca yeni bir çalışanın katılımı için geçerlidir. Katılan çalışanın üyeliği kalıcıdır.");
    } catch (error) {
      setInviteCodeMessage(error instanceof Error ? error.message : "Davet kodu oluşturulamadı.");
    } finally {
      setInviteCodeBusy(false);
    }
  }

  async function copyInviteCode() {
    if (!createdInviteCode) return;
    try {
      await navigator.clipboard.writeText(createdInviteCode);
      setInviteCodeMessage("Davet kodu panoya kopyalandı.");
    } catch {
      setInviteCodeMessage("Kod kopyalanamadı. Kodu seçip elle kopyalayabilirsin.");
    }
  }

  async function signOut() {
  if (!supabase) return;

  const { error } = await supabase.auth.signOut();

  if (error) {
    setNotice(`Çıkış yapılamadı: ${error.message}`);
  }
  }

  async function deleteOwnAccount() {
    if (!supabase || !user || accountDeleteBusy) return;
    setAccountDeleteBusy(true);
    setAccountDeleteError("");
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("Oturum doğrulanamadı. Yeniden giriş yap.");

      const response = await fetch("/api/account/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT" }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Hesap silinemedi.");

      await supabase.auth.signOut();
      setAccountDeleteStep(0);
      window.location.assign("/");
    } catch (error) {
      setAccountDeleteError(error instanceof Error ? error.message : "Hesap silinemedi.");
    } finally {
      setAccountDeleteBusy(false);
    }
  }
    async function closeOrganization() {
    if (!supabase || !organizationId || membershipRole !== "owner" || organizationCloseBusy) return;

    setOrganizationCloseBusy(true);
    setOrganizationCloseError("");

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;

      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("Oturum doğrulanamadı. Yeniden giriş yap.");

      const response = await fetch("/api/organization/close", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          organizationId,
          confirmation: "CLOSE_ORGANIZATION",
        }),
      });

      const result = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        throw new Error(result.error || "İşletme kapatılamadı.");
      }

      await supabase.auth.signOut();
      window.location.assign("/");
    } catch (error) {
      setOrganizationCloseError(
        error instanceof Error ? error.message : "İşletme kapatılamadı."
      );
    } finally {
      setOrganizationCloseBusy(false);
    }
  }
  const selected = objects.find((o) => o.id === selectedId) ?? null;
  const allProducts = useMemo(() => objects.flatMap((o) => o.products.map((p) => ({ ...p, objectId: o.id, objectLabel: o.label, objectType: o.type }))), [objects]);
  const results = search.trim()
    ? allProducts.filter((p) => p.name.toLocaleLowerCase("tr").includes(search.trim().toLocaleLowerCase("tr")))
    : [];

  async function recordActivity(
    action: string,
    entityType: string,
    entityId: string | null,
    details: Record<string, unknown>
  ) {
    if (!supabase || !organizationId || !user) return;
    const { error } = await supabase.from("audit_logs").insert({
      organization_id: organizationId,
      user_id: user.id,
      action,
      entity_type: entityType,
      entity_id: entityId,
      details: {
        ...details,
        actor_name: user.username || user.email || "Bilinmeyen kullanıcı",
        actor_email: user.email || "Bilinmeyen kullanıcı",
      },
    });
    if (error) {
      setNotice(`İşlem yapıldı ancak işlem geçmişine yazılamadı: ${error.message}`);
    }
  }

  async function loadActivityLogs() {
    if (!supabase || !organizationId) return;
    setActivityLoading(true);
    setActivityError("");
    const { data, error } = await supabase
      .from("audit_logs")
      .select("id,user_id,action,entity_type,entity_id,details,created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      setActivityError(error.message);
      setActivityLogs([]);
    } else {
      setActivityLogs((data ?? []) as ActivityLog[]);
    }
    setActivityLoading(false);
  }

  const filteredActivityLogs = useMemo(() => {
    const userQuery = activityUserSearch.trim().toLocaleLowerCase("tr");
    const productQuery = activityProductSearch.trim().toLocaleLowerCase("tr");
    return activityLogs.filter((log) => {
      const details = log.details || {};
      const actor = String(details.actor_email || details.actor_name || log.user_id || "").toLocaleLowerCase("tr");
      const product = String(details.product_name || details.name || details.description || "").toLocaleLowerCase("tr");
      const actionMatch = activityActionFilter === "all" || log.action === activityActionFilter;
      const date = new Date(log.created_at);
      const fromMatch = !activityDateFrom || date >= new Date(`${activityDateFrom}T00:00:00`);
      const toMatch = !activityDateTo || date <= new Date(`${activityDateTo}T23:59:59.999`);
      return (!userQuery || actor.includes(userQuery)) && (!productQuery || product.includes(productQuery)) && actionMatch && fromMatch && toMatch;
    });
  }, [activityLogs, activityUserSearch, activityProductSearch, activityActionFilter, activityDateFrom, activityDateTo]);

  function activityActionLabel(action: string) {
    const labels: Record<string, string> = {
      product_add: "Ürün eklendi",
      stock_add: "Stok artırıldı",
      stock_remove: "Stok azaltıldı",
      product_remove: "Ürün konumdan çıkarıldı",
      object_add: "Konum eklendi",
      object_remove: "Konum silindi",
    };
    return labels[action] || action;
  }

  function updateWarehouse(patch: WarehousePatch) {
    if (patch.name !== undefined) setWarehouseName(patch.name);
    if (patch.width_m !== undefined) setWidthM(patch.width_m);
    if (patch.length_m !== undefined) setLengthM(patch.length_m);
    if (patch.grid_size_m !== undefined) setGridM(patch.grid_size_m);
    if (!supabase || !warehouseId || !organizationId) return;
    void supabase.from("warehouses").update(patch).eq("id", warehouseId).eq("organization_id", organizationId)
      .then(({ error }) => { if (error) setNotice(`Depo ayarı kaydedilemedi: ${error.message}`); });
  }

  function updateObject(id: string, patch: Partial<MapObject>) {
    setObjects((prev) => prev.map((o) => o.id === id ? { ...o, ...patch } : o));
    if (!supabase || !organizationId || !warehouseId) return;
    const dbPatch: Record<string, string | number> = {};
    if (patch.label !== undefined) dbPatch.label = patch.label;
    if (patch.x !== undefined) dbPatch.x_m = patch.x;
    if (patch.y !== undefined) dbPatch.y_m = patch.y;
    if (patch.width !== undefined) dbPatch.width_m = patch.width;
    if (patch.length !== undefined) dbPatch.length_m = patch.length;
    if (patch.rotation !== undefined) dbPatch.rotation_deg = patch.rotation;
    if (Object.keys(dbPatch).length === 0) return;
    void supabase.from("map_objects").update(dbPatch).eq("id", id).eq("warehouse_id", warehouseId).eq("organization_id", organizationId)
      .then(({ error }) => { if (error) setNotice(`Nesne kaydedilemedi: ${error.message}`); });
    if (patch.label !== undefined && storageUnitIds[id]) {
      void supabase.from("storage_units").update({ label: patch.label }).eq("id", storageUnitIds[id]).eq("organization_id", organizationId)
        .then(({ error }) => { if (error) setNotice(`Konum etiketi kaydedilemedi: ${error.message}`); });
    }
  }

  async function addObject(type: MapObjectType) {
    const count = objects.filter((o) => o.type === type).length + 1;
    const labels: Record<MapObjectType, string> = { pallet: `Palet P-${String(count).padStart(3, "0")}`, rack: `Raf ${count}`, cart: `Araba A-${String(count).padStart(2, "0")}`, wall: `Duvar ${count}`, aisle: `Koridor ${count}` };
    const object: MapObject = {
      id: makeId(), type, label: labels[type], x: 1 + (count % 4) * 1.5, y: 1 + (count % 3) * 1.5,
      width: type === "rack" ? 2 : type === "wall" ? 3 : type === "aisle" ? 2 : 1,
      length: type === "rack" ? 1 : type === "wall" ? 0.1 : type === "aisle" ? 1 : 0.8,
      rotation: 0, products: []
    };

    if (supabase && organizationId && warehouseId) {
      const { error: objectError } = await supabase.from("map_objects").insert({
        id: object.id, organization_id: organizationId, warehouse_id: warehouseId, object_type: type,
        label: object.label, x_m: object.x, y_m: object.y, width_m: object.width, length_m: object.length, rotation_deg: 0
      });
      if (objectError) { setNotice(`Nesne eklenemedi: ${objectError.message}`); return; }

      if (["pallet", "rack", "cart"].includes(type)) {
        const unitType = type as "pallet" | "rack" | "cart";
        const { data: unit, error: unitError } = await supabase.from("storage_units").insert({
          id: makeId(), organization_id: organizationId, warehouse_id: warehouseId, map_object_id: object.id,
          unit_type: unitType, label: object.label
        }).select("id").single();
        if (unitError) {
          await supabase.from("map_objects").delete().eq("id", object.id).eq("organization_id", organizationId);
          setNotice(`Depolama konumu oluşturulamadı: ${unitError.message}`);
          return;
        }
        setStorageUnitIds((prev) => ({ ...prev, [object.id]: unit.id }));
      }
    }
    if (supabase && organizationId) {
      await recordActivity("object_add", "map_object", object.id, {
        object_label: object.label,
        object_type: object.type,
        description: `${object.label} konumu eklendi`,
      });
    }
    setObjects((prev) => [...prev, object]);
    setSelectedId(object.id);
    setNotice(`${object.label} eklendi${supabase ? " ve buluta kaydedildi." : " (yerel demo)."}`);
  }

  async function removeObject(id: string) {
    const target = objects.find((o) => o.id === id);
    if (!target) return;
    const confirmed = window.confirm(`${target.label} kaldırılsın mı? Bu konumdaki ürün yerleşimleri de kaldırılacak.`);
    if (!confirmed) return;
    if (supabase && organizationId && warehouseId) {
      const { error } = await supabase.from("map_objects").delete().eq("id", id).eq("warehouse_id", warehouseId).eq("organization_id", organizationId);
      if (error) { setNotice(`Nesne silinemedi: ${error.message}`); return; }
    }
    if (supabase && organizationId) {
      await recordActivity("object_remove", "map_object", id, {
        object_label: target.label,
        object_type: target.type,
        description: `${target.label} konumu silindi`,
        removed_products: target.products.map((product) => product.name),
      });
    }
    setObjects((prev) => prev.filter((o) => o.id !== id));
    setStorageUnitIds((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setSelectedId((current) => current === id ? null : current);
    setNotice(`${target.label} kaldırıldı.`);
  }

  async function addProduct() {
    if (!selected || !["pallet", "rack", "cart"].includes(selected.type)) {
      setNotice("Önce palet, raf veya araba seç.");
      return;
    }
    if (!productName.trim()) {
      setNotice("Ürün adı gerekli.");
      return;
    }
    const q = unknownQuantity || quantity.trim() === "" ? null : Number(quantity);
    if (q !== null && (!Number.isFinite(q) || q < 0)) {
      setNotice("Miktar sıfır veya daha büyük olmalı.");
      return;
    }

    if (supabase && organizationId && warehouseId) {
      let unitId = storageUnitIds[selected.id];
      if (!unitId) {
        const { data: unit, error: unitError } = await supabase.from("storage_units").select("id").eq("map_object_id", selected.id).eq("organization_id", organizationId).maybeSingle();
        if (unitError || !unit) { setNotice(`Bu nesne için depolama konumu bulunamadı${unitError ? `: ${unitError.message}` : "."}`); return; }
        unitId = unit.id;
        setStorageUnitIds((prev) => ({ ...prev, [selected.id]: unitId! }));
      }

      let productId: string;
      const { data: existingProducts, error: findProductError } = await supabase.from("products").select("id,name,unit_name").eq("organization_id", organizationId).eq("name", productName.trim()).limit(1);
      if (findProductError) { setNotice(`Ürün aranamadı: ${findProductError.message}`); return; }
      if (existingProducts?.length) {
        productId = existingProducts[0].id;
      } else {
        const { data: newProduct, error: productError } = await supabase.from("products").insert({
          id: makeId(), organization_id: organizationId, name: productName.trim(), unit_name: "adet"
        }).select("id").single();
        if (productError) { setNotice(`Ürün oluşturulamadı: ${productError.message}`); return; }
        productId = newProduct.id;
      }

      const { data: existingContent, error: contentLookupError } = await supabase.from("storage_contents").select("quantity").eq("storage_unit_id", unitId).eq("product_id", productId).maybeSingle();
      if (contentLookupError) { setNotice(`Ürün konumu kontrol edilemedi: ${contentLookupError.message}`); return; }
      const finalQuantity = existingContent
        ? (existingContent.quantity === null || q === null ? null : Number(existingContent.quantity) + q)
        : q;
      const contentWrite = existingContent
        ? await supabase.from("storage_contents").update({ quantity: finalQuantity, updated_by: user?.id, updated_at: new Date().toISOString() }).eq("storage_unit_id", unitId).eq("product_id", productId)
        : await supabase.from("storage_contents").insert({ id: makeId(), organization_id: organizationId, warehouse_id: warehouseId, storage_unit_id: unitId, product_id: productId, quantity: finalQuantity, updated_by: user?.id });
      if (contentWrite.error) { setNotice(`Ürün depoya kaydedilemedi: ${contentWrite.error.message}`); return; }
      await recordActivity(existingContent ? "stock_add" : "product_add", "product", productId, {
        product_name: productName.trim(),
        quantity: q,
        previous_quantity: existingContent?.quantity ?? 0,
        new_quantity: finalQuantity,
        unit: "adet",
        location: selected.label,
        description: `${productName.trim()} ${selected.label} konumuna ${q === null ? "miktarı bilinmeden" : `${q} adet`} eklendi`,
      });
      const { data: savedProduct } = await supabase.from("products").select("id,name,unit_name").eq("id", productId).single();
      setObjects((prev) => prev.map((o) => {
        if (o.id !== selected.id) return o;
        // Sıfır stoklu ürün arayüzden gizlenir; storage_contents kaydı silinmez.
        if (finalQuantity !== null && Number(finalQuantity) <= 0) {
          return { ...o, products: o.products.filter((p) => p.id !== productId) };
        }
        const exists = o.products.some((p) => p.id === productId);
        const nextProduct: ProductEntry = { id: productId, name: savedProduct?.name || productName.trim(), quantity: finalQuantity, unit: savedProduct?.unit_name || "adet" };
        return { ...o, products: exists ? o.products.map((p) => p.id === productId ? nextProduct : p) : [...o.products, nextProduct] };
      }));
      setProductName(""); setQuantity(""); setUnknownQuantity(false);
      setNotice(`${productName.trim()}, ${selected.label} konumuna kaydedildi.`);
      return;
    }

    const product: ProductEntry = { id: makeId(), name: productName.trim(), quantity: q, unit: "adet" };
    if (q !== 0) {
      setObjects((prev) => prev.map((o) => o.id === selected.id ? { ...o, products: [...o.products, product] } : o));
    }
    setProductName(""); setQuantity(""); setUnknownQuantity(false);
    setNotice(`${product.name}, ${selected.label} konumuna eklendi (yerel demo).`);
  }

  async function adjustProductQuantity(productId: string, delta: number) {
    if (!selected || !Number.isInteger(delta) || delta === 0) return;
    const product = selected.products.find((p) => p.id === productId);
    if (!product) return;
    if (product.quantity === null) {
      setNotice("Önce ürünün miktarını belirlemelisin.");
      return;
    }

    const nextQuantity = product.quantity + delta;
    if (nextQuantity < 0) {
      setNotice("Stok miktarı sıfırın altına düşemez.");
      return;
    }

    if (supabase && organizationId) {
      const unitId = storageUnitIds[selected.id];
      if (!unitId) {
        setNotice("Bu ürün için depolama konumu bulunamadı.");
        return;
      }
      const { error } = await supabase
        .from("storage_contents")
        .update({ quantity: nextQuantity, updated_by: user?.id, updated_at: new Date().toISOString() })
        .eq("storage_unit_id", unitId)
        .eq("product_id", productId)
        .eq("organization_id", organizationId);
      if (error) {
        setNotice(`Stok miktarı güncellenemedi: ${error.message}`);
        return;
      }
      await recordActivity(delta > 0 ? "stock_add" : "stock_remove", "product", productId, {
        product_name: product.name,
        quantity: Math.abs(delta),
        previous_quantity: product.quantity,
        new_quantity: nextQuantity,
        unit: product.unit,
        location: selected.label,
        description: `${product.name} stoğu ${Math.abs(delta)} ${product.unit} ${delta > 0 ? "artırıldı" : "azaltıldı"} (${product.quantity} → ${nextQuantity})`,
      });
    }

    setObjects((prev) => prev.map((o) => {
      if (o.id !== selected.id) return o;
      if (nextQuantity === 0) {
        return { ...o, products: o.products.filter((p) => p.id !== productId) };
      }
      return {
        ...o,
        products: o.products.map((p) => p.id === productId ? { ...p, quantity: nextQuantity } : p),
      };
    }));
    setNotice(nextQuantity === 0 ? `${product.name} stoğu bitti ve listeden kaldırıldı.` : `${product.name} stok miktarı ${nextQuantity} ${product.unit} olarak güncellendi.`);
  }

  async function removeProduct(productId: string) {
    if (!selected) return;
    const removedProduct = selected.products.find((product) => product.id === productId);
    if (!removedProduct) return;
    if (supabase && organizationId) {
      const unitId = storageUnitIds[selected.id];
      if (!unitId) { setNotice("Bu ürün için depolama konumu bulunamadı."); return; }
      const { error } = await supabase.from("storage_contents").delete().eq("storage_unit_id", unitId).eq("product_id", productId).eq("organization_id", organizationId);
      if (error) { setNotice(`Ürün konumdan çıkarılamadı: ${error.message}`); return; }
      await recordActivity("product_remove", "product", productId, {
        product_name: removedProduct.name,
        quantity: removedProduct.quantity,
        unit: removedProduct.unit,
        location: selected.label,
        description: `${removedProduct.name} ${selected.label} konumundan çıkarıldı`,
      });
    }
    setObjects((prev) => prev.map((o) => o.id === selected.id ? { ...o, products: o.products.filter((p) => p.id !== productId) } : o));
    setNotice("Ürün bu konumdan çıkarıldı.");
  }

  function moveObject(id: string, x: number, y: number, free: boolean) {
    const obj = objects.find((o) => o.id === id);
    if (!obj) return;
    const snap = (v: number) => Math.round(v / gridM) * gridM;
    const nextX = free ? x : snap(x);
    const nextY = free ? y : snap(y);
    updateObject(id, {
      x: Math.max(0, Math.min(widthM - obj.width, nextX)),
      y: Math.max(0, Math.min(lengthM - obj.length, nextY))
    });
  }

  function startMapMousePan(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 1) return;
    e.preventDefault();
    panGesture.current = { kind: "mouse", lastX: e.clientX, lastY: e.clientY, lastDistance: 0 };
  }

  function moveMapMousePan(e: React.MouseEvent<HTMLDivElement>) {
    if (panGesture.current.kind !== "mouse") return;
    setPan((current) => ({ x: current.x + e.clientX - panGesture.current.lastX, y: current.y + e.clientY - panGesture.current.lastY }));
    panGesture.current.lastX = e.clientX;
    panGesture.current.lastY = e.clientY;
  }

  function endMapPan() { panGesture.current.kind = null; }

  function touchCenter(touches: React.TouchList) {
    return { x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 };
  }

  function touchDistance(touches: React.TouchList) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  function startMapTouchPan(e: React.TouchEvent<HTMLDivElement>) {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      panGesture.current = { kind: "touch", lastX: touch.clientX, lastY: touch.clientY, lastDistance: 0 };
      return;
    }
    if (e.touches.length === 2) {
      e.preventDefault();
      const center = touchCenter(e.touches);
      panGesture.current = { kind: "touch", lastX: center.x, lastY: center.y, lastDistance: touchDistance(e.touches) };
    }
  }

  function moveMapTouchPan(e: React.TouchEvent<HTMLDivElement>) {
    if (panGesture.current.kind !== "touch") return;
    if (e.touches.length === 1) {
      e.preventDefault();
      const touch = e.touches[0];
      setPan((current) => ({ x: current.x + touch.clientX - panGesture.current.lastX, y: current.y + touch.clientY - panGesture.current.lastY }));
      panGesture.current.lastX = touch.clientX;
      panGesture.current.lastY = touch.clientY;
      panGesture.current.lastDistance = 0;
      return;
    }
    if (e.touches.length === 2) {
      e.preventDefault();
      const center = touchCenter(e.touches);
      const distance = touchDistance(e.touches);
      const previousDistance = panGesture.current.lastDistance || distance;
      const zoomRatio = distance / Math.max(1, previousDistance);
      setPan((current) => ({ x: current.x + center.x - panGesture.current.lastX, y: current.y + center.y - panGesture.current.lastY }));
      if (Math.abs(zoomRatio - 1) > 0.005) {
        setMapZoom((current) => Math.max(0.6, Math.min(2.2, Number((current * zoomRatio).toFixed(3)))));
      }
      panGesture.current.lastX = center.x;
      panGesture.current.lastY = center.y;
      panGesture.current.lastDistance = distance;
    }
  }

  function moveMapBy(dx: number, dy: number) {
    setPan((current) => ({ x: current.x + dx, y: current.y + dy }));
  }

  function changeMapZoom(delta: number) {
    setMapZoom((current) => Math.max(0.6, Math.min(2.2, Number((current + delta).toFixed(2)))));
  }

  const canvasWidth = Math.max(300, widthM * SCALE);
  const canvasHeight = Math.max(240, lengthM * SCALE);

  if (isCloudConfigured && authLoading) {
    return <main className="app-shell"><section className="panel" style={{ maxWidth: 520, margin: "12vh auto", padding: 32 }}><h1>deStock</h1><p>Oturum kontrol ediliyor...</p></section></main>;
  }

  if (isCloudConfigured && !user) {
    return (
      <main className="app-shell">
        <section className="panel" style={{ maxWidth: 480, margin: "8vh auto", padding: 32 }}>
          <div className="brand-mark" style={{ marginBottom: 16 }}>D</div>
          <p className="eyebrow">DesStock / Bulut Hesabı</p>
          <h1 style={{ marginBottom: 8 }}>{authMode === "signin" ? "Hesabına giriş yap" : "Yeni hesap oluştur"}</h1>
          <p className="subtitle">Depo bilgilerin hesabına kaydedilir ve yetkili ekip üyeleriyle senkronize edilir.</p>
          <form onSubmit={handleAuthSubmit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
            <label className="field-label">E-posta<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="field-label">Şifre<input type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            {authMode === "signup" && <label className="field-label">Davet kodu <span style={{ color: "#999", fontWeight: 400 }}>(çalışan hesabı için)</span><input autoCapitalize="characters" placeholder="DSK-XXXXXXXXXXXX" value={inviteCodeInput} onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())} /></label>}
            <button className="primary-button full-button" type="submit" disabled={authBusy}>{authBusy ? "İşleniyor..." : authMode === "signin" ? "Giriş yap" : "Hesap oluştur"}</button>
          </form>
          <button type="button" className="secondary-button full-button" style={{ marginTop: 12 }} onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setDataError(null); }}>
            {authMode === "signin" ? "Yeni hesap oluştur" : "Zaten hesabım var · Giriş yap"}
          </button>
          {dataError && <p role="alert" style={{ color: "#b42318", marginTop: 16 }}>{dataError}</p>}
          {notice && !dataError && <p className="helper-text" style={{ marginTop: 16 }}>{notice}</p>}
          <p className="helper-text" style={{ marginTop: 18 }}>Hesap oluştururken e-posta doğrulaması istenebilir. Bu ayar Supabase Authentication bölümünden yönetilir.</p>
        </section>
      </main>
    );
  }

  if (isCloudConfigured && user && isSettingPassword) {
  return (
    <main className="app-shell">
      <section
        className="panel"
        style={{ maxWidth: 480, margin: "8vh auto", padding: 32 }}
      >
        <div className="brand-mark" style={{ marginBottom: 16 }}>D</div>
        <p className="eyebrow">DesStock / Davet</p>
        <h1>Şifreni belirle</h1>
        <p className="subtitle">
          Ekibine katılmak için hesabının şifresini oluştur.
        </p>

        <form
          onSubmit={handleSetPassword}
          style={{ display: "grid", gap: 14, marginTop: 24 }}
        >
          <label className="field-label">
            Yeni şifre
            <input
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          <button
            className="primary-button full-button"
            type="submit"
            disabled={authBusy}
          >
            {authBusy ? "Kaydediliyor..." : "Şifremi oluştur"}
          </button>
        </form>

        {dataError && (
          <p role="alert" style={{ color: "#b42318", marginTop: 16 }}>
            {dataError}
          </p>
        )}
      </section>
    </main>
  );
}

  return (
    <main className="app-shell">
      <style jsx global>{`
        .app-shell { min-height: 100vh; background: #090a0d !important; color: #f2f3f5 !important; }
        .app-shell { text-transform: capitalize; }
        .app-shell input, .app-shell textarea, .app-shell select { text-transform: none !important; }
        .app-shell .panel, .app-shell .map-panel, .app-shell .search-panel { background: #14161b !important; color: #f2f3f5 !important; border: 1px solid #292d36 !important; box-shadow: 0 12px 36px rgba(0,0,0,.22); }
        .app-shell .topbar { background: #0d0f13 !important; border-bottom: 1px solid #292d36 !important; }
        .app-shell .topbar-actions { display: flex; align-items: center; gap: 10px; }
        .app-shell .mobile-menu-toggle { display: none; align-items: center; gap: 8px; }
        .app-shell .brand-mark { background: linear-gradient(145deg,#ff555d,#a90f1c) !important; color: white !important; box-shadow: 0 0 22px rgba(220,35,48,.22); }
        .app-shell .brand-lockup { display: flex; align-items: center; gap: 18px; min-width: 0; }
        .app-shell .brand-product, .app-shell .brand-maker { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .app-shell .brand-product-logo { display: block; width: 42px; height: 42px; object-fit: contain; flex: 0 0 42px; border-radius: 8px; }
        .app-shell .brand-maker-logo { display: block; width: 38px; height: 38px; object-fit: contain; flex: 0 0 38px; }
        .app-shell .brand-copy { display: grid; gap: 2px; min-width: 0; }
        .app-shell .brand-copy strong { font-size: 15px; line-height: 1.15; letter-spacing: .1px; white-space: nowrap; }
        .app-shell .brand-copy span { font-size: 11px; line-height: 1.25; color: #8f96a3; white-space: nowrap; }
        .app-shell .brand-divider { width: 1px; height: 36px; background: #343944; flex: 0 0 1px; }
        .app-shell .brand-maker-name { font-size: 14px; line-height: 1.15; color: #f7f7f8; white-space: nowrap; }
        .app-shell .brand-maker-name .des { color: #f7f7f8; }\n        .app-shell .brand-maker-name .kaiz { color: #f0444e; }
        .app-shell .brand-copy strong, .app-shell h1, .app-shell h2, .app-shell h3 { color: #f7f7f8 !important; }
        .app-shell .subtitle, .app-shell .helper-text, .app-shell .panel-kicker, .app-shell .field-label { color: #aeb3bd !important; }
        .app-shell input, .app-shell select { background: #0d0f13 !important; color: #f5f5f6 !important; border: 1px solid #363b46 !important; }
        .app-shell .primary-button { background: linear-gradient(135deg,#f0444e,#b81727) !important; border: 1px solid #f0444e !important; color: white !important; }
        .app-shell .secondary-button, .app-shell .add-button { background: #1b1e25 !important; color: #f0f1f3 !important; border: 1px solid #383d48 !important; }
        .app-shell .map-viewport { background: #0b0d11 !important; border: 1px solid #333844 !important; overflow: hidden !important; user-select: none; }
        .app-shell .map-scroll { will-change: transform; }
        .app-shell .metric-card, .app-shell .selected-object, .app-shell .product-row, .app-shell .search-result, .app-shell .invite-code-card { background: #1b1e25 !important; border-color: #343944 !important; color: #f2f3f5 !important; }
        .app-shell .invite-code-card { display: grid; gap: 10px; padding: 14px; margin-top: 12px; border: 1px solid #71313a !important; border-radius: 12px; }
        .app-shell .invite-code-card strong { color: #ff5a64; font: 700 20px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 1px; overflow-wrap: anywhere; }
        .app-shell .footer { color: #858b98 !important; border-top: 1px solid #292d36 !important; }
        .app-shell .map-legend, .app-shell .map-footer { color: #b9bec8 !important; }
        .app-shell .map-controls { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 10px 0 2px; }
        .app-shell .map-pan-pad { display: grid; justify-items: center; gap: 4px; }
        .app-shell .map-pan-pad > div { display: flex; gap: 4px; }
        .app-shell .map-pan-pad button, .app-shell .map-zoom-controls button { min-width: 38px; min-height: 36px; border: 1px solid #383d48; border-radius: 8px; background: #1b1e25; color: #f2f3f5; font-size: 18px; cursor: pointer; }
        .app-shell .map-zoom-controls { display: flex; align-items: center; gap: 7px; }
        .app-shell .map-zoom-controls span { min-width: 48px; text-align: center; color: #c4c8d0; font-size: 12px; font-variant-numeric: tabular-nums; }
        .app-shell .map-zoom-controls button:last-child { padding: 0 10px; font-size: 12px; }
        /* Mobil düzen: mevcut masaüstü yapısı korunur, yalnızca küçük ekranlarda yeniden akar. */
        @media (max-width: 760px) {
          .app-shell {
            width: 100%;
            min-width: 0;
            overflow-x: hidden;
            padding-bottom: max(18px, env(safe-area-inset-bottom));
          }
          .app-shell .topbar {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
            padding: 12px 14px;
          }
          .app-shell .brand-lockup { gap: 10px; flex: 1 1 auto; }
          .app-shell .brand-product, .app-shell .brand-maker { gap: 7px; }
          .app-shell .brand-product-logo { width: 36px; height: 36px; flex-basis: 36px; }
          .app-shell .brand-maker-logo { width: 30px; height: 30px; flex-basis: 30px; }
          .app-shell .brand-divider { height: 30px; }
          .app-shell .brand-copy strong { font-size: 13px; }
          .app-shell .brand-copy span { font-size: 9px; }
          .app-shell .brand-maker-name { font-size: 11px; }
          .app-shell .topbar-spacer { display: none; }
          .app-shell .mobile-menu-toggle { display: inline-flex; flex: 0 0 auto; min-height: 42px; }
          .app-shell .topbar { position: relative !important; height: auto !important; min-height: 0 !important; overflow: visible !important; }
          .app-shell .topbar-actions {
            position: static !important;
            inset: auto !important;
            transform: none !important;
            float: none !important;
            display: none;
            width: 100%;
            flex: 1 0 100%;
            flex-direction: column;
            align-items: stretch;
            gap: 8px;
            padding-top: 8px;
          }
          .app-shell .topbar-actions.is-open { display: flex; position: static !important; }
          .app-shell .topbar-actions > * { position: static !important; float: none !important; transform: none !important; }
          .app-shell .topbar-actions > button,
          .app-shell .topbar-actions > .status-pill {
            width: 100%;
            min-height: 42px;
            justify-content: center;
            margin: 0 !important;
            box-sizing: border-box;
            text-align: center;
          }
          .app-shell .welcome-row {
            position: relative !important;
            clear: both !important;
            display: grid;
            grid-template-columns: minmax(0, 1fr);
            gap: 12px;
            padding: 22px 14px 16px;
          }
          .app-shell .welcome-row h1 {
            font-size: clamp(25px, 7vw, 34px);
            line-height: 1.12;
            letter-spacing: -0.7px;
            overflow-wrap: anywhere;
          }
          .app-shell .welcome-row .subtitle {
            font-size: 14px;
            line-height: 1.55;
            margin-top: 9px;
          }
          .app-shell .welcome-row .eyebrow { font-size: 10px; letter-spacing: 1.5px; }
          .app-shell .demo-notice {
            width: 100%;
            box-sizing: border-box;
            padding: 11px 13px;
            border-radius: 12px;
            font-size: 12px;
            line-height: 1.45;
          }
          .app-shell .workspace {
            display: flex !important;
            flex-direction: column;
            gap: 14px;
            width: 100%;
            min-width: 0;
            padding: 0 12px;
            box-sizing: border-box;
          }
          .app-shell .map-panel { order: 0; width: 100%; min-width: 0; }
          .app-shell .detail-panel { order: 1; width: 100%; min-width: 0; }
          .app-shell .settings-panel { order: 2; width: 100%; min-width: 0; }
          .app-shell .panel,
          .app-shell .map-panel,
          .app-shell .search-panel {
            box-sizing: border-box;
            border-radius: 15px;
            padding: 14px;
          }
          .app-shell .panel-heading { gap: 10px; align-items: flex-start; }
          .app-shell .panel-heading h2,
          .app-shell .map-header h2 { font-size: 18px; line-height: 1.25; }
          .app-shell .panel-kicker { font-size: 10px; letter-spacing: 1.35px; }
          .app-shell .map-header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 12px;
            flex-wrap: wrap;
            padding-bottom: 12px;
          }
          .app-shell .map-header > div:first-child { min-width: 0; }
          .app-shell .map-header p { font-size: 12px; }
          .app-shell .map-legend {
            display: flex;
            flex-wrap: wrap;
            gap: 8px 12px;
            font-size: 11px;
          }
          .app-shell .map-viewport {
            position: relative !important;
            width: 100%;
            min-width: 0;
            height: min(54svh, 470px);
            min-height: 290px;
            max-height: 470px !important;
            overflow: hidden !important;
            border-radius: 10px;
            touch-action: none;
          }
          .app-shell .map-scroll { transform-origin: top left; }
          .app-shell .map-controls { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 0 2px; }
          .app-shell .map-pan-pad, .app-shell .map-zoom-controls { background: rgba(15,17,22,.92); border: 1px solid #424753; border-radius: 12px; padding: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
          .app-shell .map-pan-pad button, .app-shell .map-zoom-controls button { min-width: 40px; min-height: 40px; touch-action: manipulation; }
          .app-shell .map-zoom-controls { gap: 4px; }
          .app-shell .map-zoom-controls span { min-width: 38px; font-size: 11px; }
          .app-shell .map-footer {
            display: flex;
            flex-wrap: wrap;
            gap: 7px 12px;
            padding-top: 10px;
            font-size: 10px;
          }
          .app-shell .map-footer kbd { font-size: 10px; }
          .app-shell .field-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
          }
          .app-shell .field-label { min-width: 0; font-size: 12px; }
          .app-shell input:not([type="checkbox"]),
          .app-shell select {
            width: 100%;
            min-width: 0;
            min-height: 43px;
            box-sizing: border-box;
            font-size: 14px;
            padding: 10px 11px;
            border-radius: 9px;
          }
          .app-shell button { min-height: 40px; }
          .app-shell .add-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
          .app-shell .add-button { min-width: 0; padding: 10px 8px; gap: 6px; }
          .app-shell .add-button b { margin-left: auto; }
          .app-shell .selected-object { gap: 10px; padding: 11px; }
          .app-shell .selected-object > div { min-width: 0; }
          .app-shell .selected-object strong { overflow-wrap: anywhere; }
          .app-shell .product-list { display: grid; gap: 8px; }
          .app-shell .product-row {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            padding: 10px;
          }
          .app-shell .product-copy { min-width: 0; flex: 1; }
          .app-shell .product-copy strong,
          .app-shell .product-copy span { overflow-wrap: anywhere; }
          .app-shell .add-product-form { display: grid; gap: 11px; }
          .app-shell .full-button { width: 100%; min-height: 44px; }
          .app-shell .search-panel {
            display: grid;
            grid-template-columns: minmax(0, 1fr);
            gap: 12px;
            margin: 14px 12px 0;
            width: calc(100% - 24px);
          }
          .app-shell .search-content,
          .app-shell .search-input-wrap { min-width: 0; width: 100%; }
          .app-shell .search-result { min-width: 0; gap: 8px; padding: 11px; }
          .app-shell .result-action { display: none; }
          .app-shell .footer {
            display: flex;
            flex-wrap: wrap;
            gap: 6px 12px;
            padding: 16px 14px;
            font-size: 10px;
          }
        }
        @media (max-width: 380px) {
          .app-shell .workspace { padding-left: 8px; padding-right: 8px; }
          .app-shell .welcome-row { padding-left: 12px; padding-right: 12px; }
          .app-shell .panel, .app-shell .map-panel { padding: 11px; }
          .app-shell .add-grid { grid-template-columns: 1fr; }
          .app-shell .map-viewport { min-height: 250px; height: 48svh; }
          .app-shell .topbar > button { flex-basis: calc(50% - 8px); }
        }
      `}</style>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-product">
            <img className="brand-product-logo" src="/icon-512.png" alt="deStock logosu" />
            <div className="brand-copy">
              <strong>DesStock</strong>
              <span>Depo Konum Yönetimi</span>
            </div>
          </div>
          <span className="brand-divider" aria-hidden="true" />
          <div className="brand-maker">
            <img className="brand-maker-logo" src="/deskaiz-logo.png" alt="DesKaiz logosu" />
            <div className="brand-copy">
              <strong className="brand-maker-name">Made By <span className="des">Des</span><span className="kaiz">Kaiz</span></strong>
            </div>
          </div>
        </div>
        <div className="topbar-spacer" />
        <button
          type="button"
          className="mobile-menu-toggle secondary-button"
          aria-label={mobileMenuOpen ? "Menüyü kapat" : "Menüyü aç"}
          aria-expanded={mobileMenuOpen}
          onClick={() => setMobileMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">{mobileMenuOpen ? "×" : "☰"}</span>
          <span>{mobileMenuOpen ? "Kapat" : "Menü"}</span>
        </button>
        <div className={`topbar-actions ${mobileMenuOpen ? "is-open" : ""}`}>
          <button type="button" className="secondary-button" onClick={() => { setShowAllProducts(true); setMobileMenuOpen(false); }}>
            Ürün listesi ({allProducts.length})
          </button>
          {canManageWarehouse && supabase && <button type="button" className="secondary-button" onClick={() => { setShowActivity(true); setMobileMenuOpen(false); void loadActivityLogs(); }}>
            İşlemler
          </button>}
          {isCloudConfigured ? <>
            <span className={`status-pill ${dataError ? "status-warn" : ""}`}>{dataError ? "Bulut hatası" : "Bulut bağlantısı"}</span>
            <button type="button" className="secondary-button" onClick={() => { void signOut(); setMobileMenuOpen(false); }}>Çıkış yap</button>
            <button type="button" className="secondary-button" onClick={() => { setAccountDeleteError(""); setAccountDeleteStep(1); setMobileMenuOpen(false); }} style={{ color: "#ff6b73", borderColor: "#71313a" }}>Hesabımı sil</button>
          </> : <span className="status-pill status-warn">Yerel demo · bulut ayarı yok</span>}
        </div>
      </header>

      <section className="welcome-row">
        <div>
          <p className="eyebrow">Depo Yönetimi / Harita Editörü</p>
          <h1>Depodaki her şeyin yerini bil...</h1>
          <p className="subtitle">Ölçülü harita üzerinde palet, raf ve arabaları yerleştir. Ürün konumlarını tek ekrandan yönet.</p>
        </div>
        <div className="demo-notice"><span className="notice-dot" /> {notice}</div>
      </section>

      {dataError && <div role="alert" className="demo-notice" style={{ marginBottom: 16, color: "#b42318" }}>Bulut bağlantısı: {dataError}. SQL erişim kurulumunu kontrol et.</div>}
      <section className="workspace">
        <aside className="panel settings-panel">
          <div className="panel-heading"><div><span className="panel-kicker">01 / PLAN</span><h2>Depo ayarları</h2></div></div>
          {canManageWarehouse ? (
            <>
              <label className="field-label">Depo adı<input value={warehouseName} onChange={(e) => updateWarehouse({ name: e.target.value })} /></label>
              <div className="field-grid">
                <label className="field-label">Genişlik (m)<input type="number" min="1" max="100" value={widthM} onChange={(e) => updateWarehouse({ width_m: Math.max(1, Number(e.target.value) || 1) })} /></label>
                <label className="field-label">Uzunluk (m)<input type="number" min="1" max="100" value={lengthM} onChange={(e) => updateWarehouse({ length_m: Math.max(1, Number(e.target.value) || 1) })} /></label>
              </div>
              <label className="field-label">Izgara aralığı
                <select value={gridM} onChange={(e) => updateWarehouse({ grid_size_m: Number(e.target.value) })}>
                  <option value={0.25}>25 cm</option><option value={0.5}>50 cm</option><option value={1}>1 metre</option>
                </select>
              </label>
            </>
          ) : <p className="helper-text">Depo ayarlarını yalnızca depo sahibi veya yönetici değiştirebilir.</p>}
          <div className="metric-grid">
            <div className="metric-card"><span>Alan</span><strong>{(widthM * lengthM).toLocaleString("tr-TR")} m²</strong></div>
            <div className="metric-card"><span>Nesne</span><strong>{objects.length}</strong></div>
          </div>
          {isCloudConfigured && organizationId && ["owner", "manager"].includes(membershipRole ?? "") && (
            <>
              <div className="section-rule" />
              <div className="panel-heading compact">
                <div><span className="panel-kicker">EKİP YÖNETİMİ</span><h2>Çalışan daveti</h2></div>
              </div>
              <p className="helper-text">Tek kullanımlık kod oluştur. Çalışan hesap açarken kodu girerek bu depoya katılır.</p>
              <button type="button" className="primary-button full-button" onClick={handleCreateInviteCode} disabled={inviteCodeBusy}>
                {inviteCodeBusy ? "Kod oluşturuluyor..." : "＋ Davet kodu oluştur"}
              </button>
              {createdInviteCode && (
                <div className="invite-code-card">
                  <span className="panel-kicker">7 GÜN GEÇERLİ · TEK KULLANIM</span>
                  <strong>{createdInviteCode}</strong>
                  <button type="button" className="secondary-button full-button" onClick={copyInviteCode}>Kodu kopyala</button>
                </div>
              )}
              {inviteCodeMessage && <p className="helper-text" role="status">{inviteCodeMessage}</p>}
              <div className="section-rule" />
              <div className="panel-heading compact">
                <div><span className="panel-kicker">EKİP ÜYELERİ</span><h2>İşletme ekibi ({teamMembers.length})</h2></div>
                <button type="button" className="secondary-button" onClick={() => organizationId && void loadTeamMembers(organizationId)} disabled={teamLoading}>
                  {teamLoading ? "Yükleniyor..." : "Yenile"}
                </button>
              </div>
              {teamLoading && teamMembers.length === 0 ? (
                <p className="helper-text">Ekip yükleniyor...</p>
              ) : teamMembers.length === 0 ? (
                <p className="helper-text">Henüz ekip üyesi bulunamadı.</p>
              ) : (
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {teamMembers.map((member) => (
                    <div key={member.user_id} className="product-row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div className="product-copy" style={{ minWidth: 0, flex: 1 }}>
                        <strong style={{ overflowWrap: "anywhere" }}>{member.email || "E-posta bilgisi yok"}</strong>
                        <span>{({ owner: "İşletme sahibi", manager: "Yönetici", worker: "Çalışan", viewer: "Görüntüleyici" } as Record<string, string>)[member.role] || member.role}</span>
                      </div>
                      {member.role !== "owner" && (membershipRole === "owner" || (membershipRole === "manager" && ["worker", "viewer"].includes(member.role))) && (
                        <button type="button" className="secondary-button" onClick={() => void handleRemoveMember(member)} style={{ color: "#ff6871", borderColor: "#71313a", flexShrink: 0 }}>
                          Üyeyi çıkar
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {teamMessage && <p className="helper-text" role="status">{teamMessage}</p>}
            </>
          )}
          {isCloudConfigured && organizationId && membershipRole === "owner" && (
            <>
              <div className="section-rule" />
              <div className="panel-heading compact">
                <div>
                  <span className="panel-kicker">İŞLETME YÖNETİMİ</span>
                  <h2>İşletmeyi kapat</h2>
                </div>
              </div>
              <p className="helper-text">
                İşletmeyi kapatmak; depo, harita, ürün, stok ve ekip verilerini
                ve işletmeye bağlı tüm kullanıcı hesaplarını kalıcı olarak siler.
              </p>
              <button
                type="button"
                className="secondary-button full-button"
                onClick={() => {
                  setOrganizationCloseError("");
                  setOrganizationCloseStep(1);
                }}
                style={{ color: "#ff6b73", borderColor: "#71313a" }}
              >
                İşletmeyi kapat
              </button>
            </>
          )}
          {canEditOperations && <>
            <div className="section-rule" />
            <div className="panel-heading compact"><div><span className="panel-kicker">02 / EKLE</span><h2>Haritaya nesne</h2></div></div>
            <div className="add-grid">
              <button onClick={() => addObject("pallet")} className="add-button"><span className="object-icon pallet-icon">▦</span><span>Palet</span><b>+</b></button>
              <button onClick={() => addObject("rack")} className="add-button"><span className="object-icon rack-icon">▤</span><span>Raf</span><b>+</b></button>
              <button onClick={() => addObject("cart")} className="add-button"><span className="object-icon cart-icon">▱</span><span>Araba</span><b>+</b></button>
            </div>
            <p className="helper-text">Nesneleri harita üzerinde sürükle. Alt tuşunu basılı tutarak ızgara dışında konumlandırabilirsin.</p>
          </>}
          {!canEditOperations && <p className="helper-text">Görüntüleyici hesabı: harita salt okunur.</p>}
        </aside>

        <section className="map-panel">
          <div className="map-header">
            <div><span className="panel-kicker">CANLI ÖNİZLEME</span><h2>{warehouseName || "Yeni depo"}</h2><p>{widthM} m × {lengthM} m · {gridM} m ızgara</p></div>
            <div className="map-legend"><span><i className="legend-dot pallet-dot" />Palet</span><span><i className="legend-dot rack-dot" />Raf</span><span><i className="legend-dot cart-dot" />Araba</span></div>
          </div>
          <div className="map-viewport" onMouseDown={startMapMousePan} onMouseMove={moveMapMousePan} onMouseUp={endMapPan} onMouseLeave={endMapPan} onAuxClick={(e) => { if (e.button === 1) e.preventDefault(); }} onTouchStart={startMapTouchPan} onTouchMove={moveMapTouchPan} onTouchEnd={endMapPan} style={{ touchAction: "none", cursor: panGesture.current.kind === "mouse" ? "grabbing" : "grab" }}>
            <div className="map-scroll" style={{ width: canvasWidth + 2, height: canvasHeight + 2, transform: `translate(${pan.x}px, ${pan.y}px) scale(${mapZoom})`, transformOrigin: "top left" }}>
              <Stage width={canvasWidth} height={canvasHeight} scaleX={1} scaleY={1}>
                <Layer>
                  <Rect x={0} y={0} width={canvasWidth} height={canvasHeight} fill="#111318" stroke="#3b3f49" strokeWidth={1} />
                  {Array.from({ length: Math.floor(widthM / gridM) + 1 }, (_, i) => (
                    <Line key={`vx-${i}`} points={[i * gridM * SCALE, 0, i * gridM * SCALE, canvasHeight]} stroke="#292d36" strokeWidth={0.7} listening={false} />
                  ))}
                  {Array.from({ length: Math.floor(lengthM / gridM) + 1 }, (_, i) => (
                    <Line key={`hy-${i}`} points={[0, i * gridM * SCALE, canvasWidth, i * gridM * SCALE]} stroke="#292d36" strokeWidth={0.7} listening={false} />
                  ))}
                  {objects.map((obj) => {
                    const isSelected = selectedId === obj.id;
                    const fill = OBJECT_COLORS[obj.type];
                    return (
                      <Group key={obj.id} x={obj.x * SCALE} y={obj.y * SCALE} rotation={obj.rotation}
                        draggable={canEditOperations}
                        onClick={() => setSelectedId(obj.id)}
                        onTap={() => setSelectedId(obj.id)}
                        onDragEnd={(e) => {
                          if (!canEditOperations) return;
                          const node = e.target;
                          const free = Boolean(e.evt.altKey);
                          moveObject(obj.id, node.x() / SCALE, node.y() / SCALE, free);
                          node.position({ x: obj.x * SCALE, y: obj.y * SCALE });
                        }}>
                        <Rect width={obj.width * SCALE} height={obj.length * SCALE} fill={fill} opacity={0.88}
                          stroke={isSelected ? "#ff424b" : "#858b98"} strokeWidth={isSelected ? 3 : 1.5} cornerRadius={5} />
                        <Text text={obj.label} width={obj.width * SCALE} height={obj.length * SCALE} align="center" verticalAlign="middle"
                          fontSize={Math.max(9, Math.min(13, obj.width * 7))} fill="#f2f3f5" listening={false} />
                      </Group>
                    );
                  })}
                </Layer>
              </Stage>
            </div>
          </div>
          <div className="map-controls" aria-label="Harita kontrolleri" onTouchStart={(e) => e.stopPropagation()} onTouchMove={(e) => e.stopPropagation()}>
            <div className="map-pan-pad" aria-label="Haritayı hareket ettir">
              <button type="button" aria-label="Haritayı yukarı kaydır" onClick={() => moveMapBy(0, 70)}>↑</button>
              <div>
                <button type="button" aria-label="Haritayı sola kaydır" onClick={() => moveMapBy(70, 0)}>←</button>
                <button type="button" aria-label="Haritayı aşağı kaydır" onClick={() => moveMapBy(0, -70)}>↓</button>
                <button type="button" aria-label="Haritayı sağa kaydır" onClick={() => moveMapBy(-70, 0)}>→</button>
              </div>
            </div>
            <div className="map-zoom-controls">
              <button type="button" aria-label="Yakınlaştır" onClick={() => changeMapZoom(0.15)}>＋</button>
              <span>{Math.round(mapZoom * 100)}%</span>
              <button type="button" aria-label="Uzaklaştır" onClick={() => changeMapZoom(-0.15)}>−</button>
              <button type="button" aria-label="Haritayı sıfırla" onClick={() => { setMapZoom(1); setPan({ x: 0, y: 0 }); }}>Sıfırla</button>
            </div>
          </div>
          <div className="map-footer"><span><kbd>Orta tuş</kbd> Kaydır</span><span><kbd>Tek parmak</kbd> Kaydır</span><span><kbd>İki parmak</kbd> Kaydır / yakınlaştır</span><span>1 m = {SCALE}px</span></div>
        </section>

        <aside className="panel detail-panel">
          <div className="panel-heading"><div><span className="panel-kicker">03 / DETAY</span><h2>Seçili nesne</h2></div></div>
          {selected ? (
            <>
              <div className="selected-object">
                <span className={`object-icon large ${selected.type}-icon`}>{selected.type === "pallet" ? "▦" : selected.type === "rack" ? "▤" : "▱"}</span>
                <div><strong>{selected.label}</strong><span>{selected.type === "pallet" ? "Palet" : selected.type === "rack" ? "Raf" : selected.type === "cart" ? "Market arabası" : selected.type}</span></div>
              </div>
              {canEditOperations ? (
                <>
              <label className="field-label">Etiket<input value={selected.label} onChange={(e) => updateObject(selected.id, { label: e.target.value })} /></label>
              <div className="field-grid">
                <label className="field-label">X (m)<input type="number" step="0.1" value={selected.x} onChange={(e) => updateObject(selected.id, { x: Math.max(0, Math.min(widthM - selected.width, Number(e.target.value) || 0)) })} /></label>
                <label className="field-label">Y (m)<input type="number" step="0.1" value={selected.y} onChange={(e) => updateObject(selected.id, { y: Math.max(0, Math.min(lengthM - selected.length, Number(e.target.value) || 0)) })} /></label>
                <label className="field-label">Genişlik<input type="number" min="0.1" step="0.1" value={selected.width} onChange={(e) => updateObject(selected.id, { width: Math.max(0.1, Number(e.target.value) || 0.1) })} /></label>
                <label className="field-label">Uzunluk<input type="number" min="0.1" step="0.1" value={selected.length} onChange={(e) => updateObject(selected.id, { length: Math.max(0.1, Number(e.target.value) || 0.1) })} /></label>
              </div>
              <button className="secondary-button full-button" onClick={() => updateObject(selected.id, { rotation: (selected.rotation + 90) % 360 })}>↻ 90° döndür</button>
              <button
                type="button"
                className="secondary-button full-button"
                onClick={() => removeObject(selected.id)}
                style={{ marginTop: 8, color: "#b42318", borderColor: "#f0b8b4" }}
              >
                × Seçili nesneyi kaldır
              </button>
                </>
              ) : (
                <p className="helper-text">Bu hesapta nesne düzenleme yetkisi yok.</p>
              )}
              <div className="section-rule" />
              <div className="panel-heading compact"><div><span className="panel-kicker">ÜRÜN İÇERİĞİ</span><h2>Ürünler <span className="count-badge">{selected.products.length}</span></h2></div></div>
              <div className="product-list">
                {selected.products.length === 0 && <p className="empty-state">Bu konumda henüz ürün yok.</p>}
                {selected.products.map((p) => (
                  <div className="product-row" key={p.id}>
                    <div className="product-symbol">P</div><div className="product-copy"><strong>{p.name}</strong><span>{p.quantity === null ? "Miktar bilinmiyor" : `${p.quantity} ${p.unit}`}</span></div>
                    {canEditOperations && p.quantity !== null && <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <button type="button" className="icon-button" title="Stoktan 1 azalt" aria-label={`${p.name} stoktan 1 azalt`} disabled={p.quantity <= 0} onClick={() => adjustProductQuantity(p.id, -1)} style={{ width: 30, height: 30, opacity: p.quantity <= 0 ? 0.45 : 1 }}>−</button>
                      <button type="button" className="icon-button" title="Stoka 1 ekle" aria-label={`${p.name} stoğa 1 ekle`} onClick={() => adjustProductQuantity(p.id, 1)} style={{ width: 30, height: 30 }}>+</button>
                    </div>}
                    {canEditOperations && <button className="icon-button" title="Ürünü bu konumdan tamamen çıkar" aria-label={`${p.name} ürününü konumdan kaldır`} onClick={() => removeProduct(p.id)}>×</button>}
                  </div>
                ))}
              </div>
              {canEditOperations && <div className="add-product-form">
                <label className="field-label">Ürün adı<input placeholder="Örn. Sakız" value={productName} onChange={(e) => setProductName(e.target.value)} /></label>
                <label className="field-label">Miktar (isteğe bağlı)<input type="number" min="0" step="1" disabled={unknownQuantity} placeholder="Örn. 12" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
                <label className="check-label"><input type="checkbox" checked={unknownQuantity} onChange={(e) => setUnknownQuantity(e.target.checked)} /> Miktarı bilmiyorum</label>
                <button className="primary-button full-button" onClick={addProduct}>+ Ürün ekle</button>
              </div>}
            </>
          ) : <p className="empty-state">Detayları görmek için haritadan bir palet, raf veya araba seç.</p>}
        </aside>
      </section>

      <section className="search-panel">
        <div className="search-intro"><span className="panel-kicker">04 / BUL</span><h2>Depoda ürün ara</h2><p>Ürün adını yaz; bulunan konumlar aşağıda listelensin.</p></div>
        <div className="search-content">
          <div className="search-input-wrap"><span>⌕</span><input aria-label="Ürün ara" placeholder="Ürün adı yaz (ör. kek, kraker)..." value={search} onChange={(e) => setSearch(e.target.value)} /><kbd>ARA</kbd></div>
          {search.trim() && <div className="search-results">
            {results.length === 0 ? <p className="empty-state">Eşleşen ürün bulunamadı.</p> : results.map((r) => (
              <button key={`${r.id}-${r.objectId}`} className="search-result" onClick={() => { setSelectedId(r.objectId); setNotice(`${r.name} bulundu: ${r.objectLabel}`); }}>
                <span className="result-marker">⌖</span><span className="result-main"><strong>{r.name}</strong><small>{r.objectLabel} · {r.quantity === null ? "Miktar bilinmiyor" : `${r.quantity} ${r.unit}`}</small></span><span className="result-action">Haritada göster →</span>
              </button>
            ))}
          </div>}
        </div>
      </section>
      {showAllProducts && (
        <div
          role="presentation"
          onClick={() => setShowAllProducts(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(15, 23, 42, 0.58)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 20
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="all-products-title"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(680px, 100%)", maxHeight: "min(80vh, 760px)",
              overflow: "auto", background: "#14161b", color: "#f2f3f5",
              borderRadius: 16, padding: 24, boxShadow: "0 24px 80px rgba(0,0,0,.25)"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
              <div>
                <span className="panel-kicker">DEPO ENVANTERİ</span>
                <h2 id="all-products-title" style={{ margin: "4px 0 0" }}>Tüm ürünler ({allProducts.length})</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Ürün listesini kapat"
                onClick={() => setShowAllProducts(false)}
                style={{ fontSize: 24 }}
              >×</button>
            </div>

            {allProducts.length === 0 ? (
              <p className="empty-state">Henüz depoya ürün eklenmemiş.</p>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {allProducts.map((product) => (
                  <button
                    type="button"
                    key={`${product.id}-${product.objectId}`}
                    className="search-result"
                    onClick={() => {
                      setSelectedId(product.objectId);
                      setShowAllProducts(false);
                      setNotice(`${product.name} bulundu: ${product.objectLabel}`);
                    }}
                    style={{
                      width: "100%", textAlign: "left", display: "flex",
                      alignItems: "center", gap: 12, padding: 14,
                      border: "1px solid #343944", borderRadius: 10,
                      background: "#1b1e25", cursor: "pointer"
                    }}
                  >
                    <span className="product-symbol">P</span>
                    <span className="result-main" style={{ flex: 1 }}>
                      <strong>{product.name}</strong>
                      <small>{product.objectLabel}</small>
                    </span>
                    <span style={{ display: "grid", justifyItems: "end", gap: 3 }}>
                      <strong style={{ color: "#15803d", fontSize: 13 }}>Depoda</strong>
                      <small style={{ color: "#aeb3bd" }}>
                        {product.quantity === null ? "Miktar bilinmiyor" : `${product.quantity} ${product.unit}`}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p style={{ color: "#aeb3bd", fontSize: 12, marginTop: 16 }}>
              Bir ürüne tıklayarak haritada bulunduğu palet, raf veya arabayı seçebilirsin.
            </p>
          </section>
        </div>
      )}

      {showActivity && (
        <div
          role="presentation"
          onClick={() => setShowActivity(false)}
          style={{ position: "fixed", inset: 0, zIndex: 1150, background: "rgba(0,0,0,.76)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="activity-title"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(1050px, 100%)", maxHeight: "min(88vh, 900px)", overflow: "auto", background: "#14161b", color: "#f2f3f5", border: "1px solid #343944", borderRadius: 16, padding: 22, boxShadow: "0 24px 80px rgba(0,0,0,.5)" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 18 }}>
              <div><span className="panel-kicker">RAPORLAMA / İSTATİSTİKLER</span><h2 id="activity-title" style={{ margin: "4px 0 0" }}>İşlem geçmişi</h2><p className="helper-text" style={{ margin: "5px 0 0" }}>Son 500 işlem · {filteredActivityLogs.length} sonuç</p></div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="secondary-button" onClick={() => void loadActivityLogs()} disabled={activityLoading}>Yenile</button>
                <button type="button" className="icon-button" aria-label="İşlem geçmişini kapat" onClick={() => setShowActivity(false)} style={{ fontSize: 22 }}>×</button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10, marginBottom: 16 }}>
              <label className="field-label">Kullanıcı ara<input placeholder="Kullanıcı adı, e-posta veya kimlik" value={activityUserSearch} onChange={(e) => setActivityUserSearch(e.target.value)} /></label>
              <label className="field-label">Ürün ara<input placeholder="Örn. ekmek" value={activityProductSearch} onChange={(e) => setActivityProductSearch(e.target.value)} /></label>
              <label className="field-label">İşlem türü<select value={activityActionFilter} onChange={(e) => setActivityActionFilter(e.target.value)}><option value="all">Tüm işlemler</option><option value="product_add">Ürün eklendi</option><option value="stock_add">Stok artırıldı</option><option value="stock_remove">Stok azaltıldı</option><option value="product_remove">Ürün konumdan çıkarıldı</option><option value="object_add">Konum eklendi</option><option value="object_remove">Konum silindi</option></select></label>
              <label className="field-label">Başlangıç tarihi<input type="date" value={activityDateFrom} onChange={(e) => setActivityDateFrom(e.target.value)} /></label>
              <label className="field-label">Bitiş tarihi<input type="date" value={activityDateTo} onChange={(e) => setActivityDateTo(e.target.value)} /></label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}><button type="button" className="secondary-button" onClick={() => { setActivityUserSearch(""); setActivityProductSearch(""); setActivityActionFilter("all"); setActivityDateFrom(""); setActivityDateTo(""); }}>Filtreleri temizle</button></div>
            {activityError && <p role="alert" style={{ color: "#ff8a91" }}>İşlemler yüklenemedi: {activityError}</p>}
            {activityLoading ? <p className="empty-state">İşlem geçmişi yükleniyor...</p> : filteredActivityLogs.length === 0 ? <p className="empty-state">Bu filtrelerle eşleşen işlem bulunamadı.</p> : (
              <div style={{ display: "grid", gap: 9 }}>
                {filteredActivityLogs.map((log) => {
                  const details = log.details || {};
                  const actor = String(details.actor_email || details.actor_name || log.user_id || "Bilinmeyen kullanıcı");
                  const description = String(details.description || details.product_name || details.object_label || activityActionLabel(log.action));
                  const quantityText = details.quantity === null || details.quantity === undefined ? "" : ` · ${String(details.quantity)} ${String(details.unit || "adet")}`;
                  return <article key={log.id} style={{ display: "grid", gridTemplateColumns: "minmax(150px,1fr) minmax(180px,2fr) auto", alignItems: "center", gap: 12, padding: 13, border: "1px solid #343944", borderRadius: 10, background: "#1b1e25" }}>
                    <div style={{ minWidth: 0 }}><strong style={{ display: "block", overflowWrap: "anywhere" }}>{actor}</strong><small style={{ color: "#9da4b1" }}>{new Date(log.created_at).toLocaleString("tr-TR")}</small></div>
                    <div style={{ minWidth: 0 }}><strong>{activityActionLabel(log.action)}</strong><div style={{ color: "#c3c7cf", fontSize: 13, overflowWrap: "anywhere" }}>{description}{quantityText}{details.location ? ` · ${String(details.location)}` : ""}</div></div>
                    <small style={{ color: "#858b98", textAlign: "right" }}>{log.entity_type}</small>
                  </article>;
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {accountDeleteStep > 0 && (
        <div
          role="presentation"
          onClick={() => { if (!accountDeleteBusy) setAccountDeleteStep(0); }}
          style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(480px, 100%)", background: "#14161b", color: "#f2f3f5", border: "1px solid #71313a", borderRadius: 14, padding: 24, boxShadow: "0 24px 80px rgba(0,0,0,.45)" }}
          >
            <span className="panel-kicker" style={{ color: "#ff6b73" }}>HESAP GÜVENLİĞİ</span>
            <h2 id="delete-account-title" style={{ margin: "8px 0 12px" }}>Hesabımı sil</h2>
            {accountDeleteStep === 1 ? (
              <>
                <p>Hesabınızı silmeyi onaylıyor musunuz?</p>
                <p className="helper-text">Hesabınızın işletme sahibi olması durumunda önce işletme sahipliğinin devredilmesi gerekir.</p>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
                  <button type="button" className="secondary-button" onClick={() => setAccountDeleteStep(0)}>Vazgeç</button>
                  <button type="button" className="primary-button" onClick={() => setAccountDeleteStep(2)}>Devam et</button>
                </div>
              </>
            ) : (
              <>
                <p style={{ color: "#ff8a91", fontWeight: 700 }}>Bu işlem geri alınamaz.</p>
                <p>Hesabınızı silmeyi onaylıyor musunuz?</p>
                <p className="helper-text">Hesabınız kalıcı olarak silinir. İşletme üyelikleriniz kaldırılır. Geçmiş stok ve işlem kayıtları korunur; hesabınızın sahibi olduğu işletmeler silinmez.</p>
                {accountDeleteError && <p role="alert" style={{ color: "#ff8a91", marginTop: 12 }}>{accountDeleteError}</p>}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
                  <button type="button" className="secondary-button" disabled={accountDeleteBusy} onClick={() => setAccountDeleteStep(0)}>İptal</button>
                  <button type="button" className="primary-button" disabled={accountDeleteBusy} onClick={deleteOwnAccount} style={{ background: "#b42318", borderColor: "#b42318" }}>{accountDeleteBusy ? "Hesap siliniyor..." : "Hesabımı kalıcı olarak sil"}</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {organizationCloseStep > 0 && (
        <div
          role="presentation"
          onClick={() => {
            if (!organizationCloseBusy) setOrganizationCloseStep(0);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1201,
            background: "rgba(0,0,0,.78)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-organization-title"
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(480px, 100%)",
              background: "#14161b",
              color: "#f2f3f5",
              border: "1px solid #71313a",
              borderRadius: 14,
              padding: 24,
              boxShadow: "0 24px 80px rgba(0,0,0,.45)",
            }}
          >
            <span className="panel-kicker" style={{ color: "#ff6b73" }}>
              GERİ DÖNÜŞÜ OLMAYAN İŞLEM
            </span>
            <h2 id="close-organization-title" style={{ margin: "8px 0 12px" }}>
              İşletmeyi kapat
            </h2>

            {organizationCloseStep === 1 ? (
              <>
                <p>İşletmenizi kapatmayı onaylıyor musunuz?</p>
                <p className="helper-text">
                  İşletmeye bağlı depo, harita, ürün, stok ve ekip bilgileri
                  kalıcı olarak silinecektir.
                </p>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setOrganizationCloseStep(0)}
                  >
                    Vazgeç
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => setOrganizationCloseStep(2)}
                  >
                    Devam et
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ color: "#ff8a91", fontWeight: 700 }}>
                  Bu işlem geri alınamaz.
                </p>
                <p>
                  İşletmeye bağlı tüm kullanıcı hesapları da kalıcı olarak silinecektir.
                </p>
                {organizationCloseError && (
                  <p role="alert" style={{ color: "#ff8a91", marginTop: 12 }}>
                    {organizationCloseError}
                  </p>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={organizationCloseBusy}
                    onClick={() => setOrganizationCloseStep(0)}
                  >
                    İptal
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={organizationCloseBusy}
                    onClick={closeOrganization}
                    style={{ background: "#b42318", borderColor: "#b42318" }}
                  >
                    {organizationCloseBusy ? "İşletme kapatılıyor..." : "İşletmeyi kalıcı olarak kapat"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      <footer className="footer"><span>DESTOCK · DEPO YÖNETİMİ</span><span>{isCloudConfigured ? "Bulut kaydı ve anlık senkronizasyon" : "Yerel demo · bulut kaydı kapalı"}</span></footer>
    </main>
  );
}
