/* ============================================================
   دوال الدفع عبر ثواني — موقع معادلة
   ============================================================
   دالتين:
   1) createCheckoutSession: تنشئ جلسة دفع بثواني وترجع رابط
      يودي الطالب لصفحة الدفع.
   2) confirmPayment: تتأكد من ثواني إن الدفع فعلاً نجح، وتفعّل
      اشتراك الطالب بـ Firestore.

   بيئة الاختبار (UAT) مستخدمة حالياً — لما يصير عندك حساب ثواني
   حقيقي، بس غيّر THAWANI_BASE و ملف .env بمفاتيحك الحقيقية.
   ============================================================ */

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// بيئة الاختبار UAT — لبيئة الإنتاج الحقيقية تصير: https://checkout.thawani.om/api/v1
const THAWANI_BASE = "https://uatcheckout.thawani.om/api/v1";

const THAWANI_SECRET_KEY = process.env.THAWANI_SECRET_KEY;
const THAWANI_PUBLISHABLE_KEY = process.env.THAWANI_PUBLISHABLE_KEY;
const SITE_URL = process.env.SITE_URL; // مثال: https://qahtansaif99-ship-it.github.io/Onlineclasses
const SUBSCRIPTION_PRICE_BAISA = Number(process.env.SUBSCRIPTION_PRICE_BAISA || 5000); // 1 ريال = 1000 بيسة

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

// ------------------------------------------------------------
// إنشاء جلسة دفع وإرجاع رابط صفحة ثواني
// ------------------------------------------------------------
exports.createCheckoutSession = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const studentId = req.body?.studentId;
    if (!studentId) return res.status(400).json({ error: "studentId مطلوب" });

    const studentRef = db.collection("students").doc(studentId);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists) return res.status(404).json({ error: "الطالب غير موجود" });
    const student = studentSnap.data();

    const thawaniRes = await fetch(`${THAWANI_BASE}/checkout/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "thawani-api-key": THAWANI_SECRET_KEY
      },
      body: JSON.stringify({
        client_reference_id: studentId,
        mode: "payment",
        products: [
          { name: "اشتراك شهري - معادلة", quantity: 1, unit_amount: SUBSCRIPTION_PRICE_BAISA }
        ],
        success_url: `${SITE_URL}/index.html?code=${studentId}&paid=1`,
        cancel_url: `${SITE_URL}/index.html?code=${studentId}`,
        metadata: { name: student.name || "", phone: student.phone || "", grade: student.grade || "" }
      })
    });

    const data = await thawaniRes.json();

    if (!thawaniRes.ok || !data?.data?.session_id) {
      console.error("Thawani create session failed:", data);
      return res.status(500).json({ error: "تعذر إنشاء جلسة الدفع بثواني", details: data });
    }

    const sessionId = data.data.session_id;
    await studentRef.update({ pendingSessionId: sessionId });

    const redirectUrl = `https://uatcheckout.thawani.om/pay/${sessionId}?key=${THAWANI_PUBLISHABLE_KEY}`;
    res.json({ redirectUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// تأكيد نجاح الدفع بعد رجوع الطالب من صفحة ثواني
// ------------------------------------------------------------
exports.confirmPayment = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const studentId = req.method === "GET" ? req.query.studentId : req.body?.studentId;
    if (!studentId) return res.status(400).json({ error: "studentId مطلوب" });

    const studentRef = db.collection("students").doc(String(studentId));
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists) return res.status(404).json({ error: "الطالب غير موجود" });
    const student = studentSnap.data();

    if (student.subscribed) {
      return res.json({ subscribed: true, alreadyActive: true });
    }
    if (!student.pendingSessionId) {
      return res.json({ subscribed: false, note: "ما في جلسة دفع مسجلة لهذا الطالب" });
    }

    const checkRes = await fetch(`${THAWANI_BASE}/checkout/session/${student.pendingSessionId}`, {
      headers: { "thawani-api-key": THAWANI_SECRET_KEY }
    });
    const checkData = await checkRes.json();
    console.log("Thawani session check:", JSON.stringify(checkData));

    // ⚠️ اسم الحقل يعتمد على استجابة ثواني الفعلية — تأكد منه بالـ logs
    // لو ما اشتغل، افحص القيمة الحقيقية بـ Firebase Console > Functions > Logs
    const status = checkData?.data?.payment_status || checkData?.data?.status;

    if (status === "paid") {
      await studentRef.update({
        subscribed: true,
        pendingSessionId: admin.firestore.FieldValue.delete()
      });
      return res.json({ subscribed: true });
    }

    res.json({ subscribed: false, status: status || "unknown" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
