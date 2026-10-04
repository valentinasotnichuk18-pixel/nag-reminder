import { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  StyleSheet, Text, TextInput, Pressable, View, FlatList, Keyboard, Alert,
  ScrollView, Switch, AppState,
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as Notifications from 'expo-notifications';
import * as Calendar from 'expo-calendar/legacy';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';

const db = SQLite.openDatabaseSync('tasks.db');

db.execSync(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Міграція: додаємо колонку deadline, якщо її ще немає
const taskColumns = db.getAllSync('PRAGMA table_info(tasks)');
if (!taskColumns.some((c) => c.name === 'deadline')) {
  db.execSync('ALTER TABLE tasks ADD COLUMN deadline TEXT');
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const CHANNEL_ID = 'reminders';
const CATEGORY_ID = 'task';
const UNDO_SECONDS = 6;
const SNOOZE_MIN = 15;
const SNOOZE_PREFIX = 'snooze-';
const MAX_SUMMARY_TIMES = 6;
const MAX_SUMMARY_LINES = 8;
const MAX_SUMMARY_EVENTS = 5;
const SUMMARY_DAYS_AHEAD = 7;

const TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Kiev';
  } catch (e) {
    return 'Europe/Kiev';
  }
})();

const INTERVALS = [
  { min: 15, label: '15 хв' },
  { min: 30, label: '30 хв' },
  { min: 60, label: '1 год' },
  { min: 120, label: '2 год' },
  { min: 180, label: '3 год' },
];

const SUMMARY_INTERVALS = [
  { min: 120, label: '2 год' },
  { min: 180, label: '3 год' },
  { min: 240, label: '4 год' },
];

const DEADLINE_DAYS = [
  { key: 'none', label: 'Без дедлайну' },
  { key: 'today', label: 'Сьогодні' },
  { key: 'tomorrow', label: 'Завтра' },
  { key: 'pick', label: 'Обрати дату' },
];

const EVENT_DAYS = DEADLINE_DAYS.filter((d) => d.key !== 'none');

const EVENT_REMINDERS = [
  { key: 15, label: 'за 15 хв' },
  { key: 30, label: 'за 30 хв' },
  { key: 60, label: 'за 1 год' },
  { key: 1440, label: 'за день' },
];

const KINDS = [
  { key: 'task', label: 'Завдання' },
  { key: 'event', label: 'Подія' },
];

function nagTitle(order) {
  if (order <= 1) return 'Нагадую';
  if (order <= 3) return 'Знову нагадую';
  if (order <= 6) return 'Я не відстану';
  return 'Ну досить відкладати!';
}

// ---------- Дата і час ----------

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(d) {
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

function minutesLabel(total) {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function isSameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

function addDays(d, days) {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function startOfDay(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfDay(d) {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

function modeForDate(d) {
  if (!d) return 'none';
  const now = new Date();
  if (isSameDay(d, now)) return 'today';
  if (isSameDay(d, addDays(now, 1))) return 'tomorrow';
  return 'pick';
}

function withDay(target, daySource) {
  const d = new Date(target);
  d.setFullYear(daySource.getFullYear(), daySource.getMonth(), daySource.getDate());
  return d;
}

function nextFullHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function deadlineInfo(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const time = formatTime(d);

  if (d < now) return { text: 'прострочено', overdue: true };
  if (isSameDay(d, now)) return { text: `до ${time}`, overdue: false };
  if (isSameDay(d, addDays(now, 1))) return { text: `завтра до ${time}`, overdue: false };
  return { text: `${formatDate(d)} до ${time}`, overdue: false };
}

function openPicker({ value, mode, minimumDate, onPick }) {
  DateTimePickerAndroid.open({
    value,
    mode,
    is24Hour: true,
    minimumDate,
    onValueChange: (...args) => {
      const date = args.find((a) => a instanceof Date);
      if (date) onPick(date);
    },
    onDismiss: () => {},
  });
}

// ---------- База ----------

function getSetting(key, defaultValue) {
  const row = db.getFirstSync('SELECT value FROM settings WHERE key = ?', key);
  return row ? Number(row.value) : defaultValue;
}

function getSettingText(key, defaultValue) {
  const row = db.getFirstSync('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.runSync(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    key,
    String(value)
  );
}

function parseTimes(text) {
  return text
    .split(',')
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

function loadSettings() {
  const oldStart = getSetting('start_hour', 8) * 60;
  const oldEnd = getSetting('end_hour', 22) * 60;
  return {
    intervalMin: getSetting('interval_min', 60),
    startMin: getSetting('start_min', oldStart),
    endMin: getSetting('end_min', oldEnd),
    summaryEnabled: getSetting('summary_enabled', 1) === 1,
    summaryMode: getSettingText('summary_mode', 'interval'),
    summaryIntervalMin: getSetting('summary_interval', 180),
    summaryTimes: parseTimes(getSettingText('summary_times', '540,780,1080')),
  };
}

function loadTasks() {
  return db.getAllSync(
    "SELECT id, title, deadline FROM tasks WHERE status = 'active' ORDER BY id DESC"
  );
}

function intervalLabel(min) {
  const found = INTERVALS.find((i) => i.min === min);
  return found ? found.label : `${min} хв`;
}

// ---------- Календар ----------

async function hasCalendarPermission(ask) {
  const { status } = ask
    ? await Calendar.requestCalendarPermissionsAsync()
    : await Calendar.getCalendarPermissionsAsync();
  return status === 'granted';
}

async function getMainCalendar() {
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const writable = calendars.filter((c) => c.allowsModifications);
  const owner = Calendar.CalendarAccessLevel.OWNER;
  return (
    writable.find((c) => c.isPrimary) ||
    writable.find((c) => c.source?.type === 'com.google' && c.accessLevel === owner) ||
    writable.find((c) => c.accessLevel === owner) ||
    writable[0] ||
    null
  );
}

// Події головного календаря за період. null: немає дозволу
async function loadEvents(from, to, ask = false) {
  try {
    if (!(await hasCalendarPermission(ask))) return null;
    const calendar = await getMainCalendar();
    if (!calendar) return [];
    const events = await Calendar.getEventsAsync([calendar.id], from, to);
    return events
      .map((e) => {
        const start = new Date(e.startDate);
        return {
          // Повторювані події мають однаковий id, тому додаємо час початку
          key: `${e.id}-${start.getTime()}`,
          title: e.title || '(без назви)',
          start,
          allDay: e.allDay,
        };
      })
      .sort((a, b) => a.start - b.start);
  } catch (e) {
    console.warn(e);
    return [];
  }
}

// Події від цього моменту до кінця дня (як у зведенні в n8n)
function loadTodayEvents(ask = false) {
  const now = new Date();
  return loadEvents(now, endOfDay(now), ask);
}

function eventTime(e) {
  return e.allDay ? 'весь день' : formatTime(e.start);
}

// ---------- Розклад нагадувань ----------

function slotsFor(createdAtIso, s) {
  const created = new Date(createdAtIso);
  const base = created.getHours() * 60 + created.getMinutes();
  const slots = [];
  for (let m = base % s.intervalMin; m < 24 * 60; m += s.intervalMin) {
    if (m >= s.startMin && m <= s.endMin) {
      const offset = (m - base + 1440) % 1440 || 1440;
      slots.push({ hour: Math.floor(m / 60), minute: m % 60, offset });
    }
  }
  slots.sort((a, b) => a.offset - b.offset);
  return slots.map((slot, i) => ({ ...slot, order: i + 1 }));
}

function countReminders(createdIso, doneIso, s) {
  const created = new Date(createdIso);
  const done = new Date(doneIso);
  const slots = slotsFor(createdIso, s);
  let count = 0;
  const day = startOfDay(created);
  while (day <= done) {
    for (const slot of slots) {
      const t = new Date(day);
      t.setHours(slot.hour, slot.minute, 0, 0);
      if (t > created && t <= done) count += 1;
    }
    day.setDate(day.getDate() + 1);
  }
  return count;
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return 'менше хвилини';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days} дн`);
  if (hours) parts.push(`${hours} год`);
  if (mins && !days) parts.push(`${mins} хв`);
  return parts.join(' ');
}

function remindersWord(n) {
  return n % 10 === 1 && n % 100 !== 11 ? 'нагадування' : 'нагадувань';
}

function doneSummary(task) {
  const duration = formatDuration(new Date(task.done_at) - new Date(task.created_at));
  const count = countReminders(task.created_at, task.done_at, loadSettings());
  if (count === 0) return `за ${duration}, без жодного нагадування`;
  return `за ${duration}, після ${count} ${remindersWord(count)}`;
}

// ---------- Зведення ----------

function summarySlots(s) {
  if (!s.summaryEnabled) return [];
  if (s.summaryMode === 'times') {
    return [...new Set(s.summaryTimes)].sort((a, b) => a - b);
  }
  const slots = [];
  for (let m = s.startMin; m <= s.endMin; m += s.summaryIntervalMin) slots.push(m);
  return slots;
}

function summaryLabel(s) {
  if (!s.summaryEnabled) return 'вимкнено';
  if (s.summaryMode === 'times') {
    return `о ${summarySlots(s).map(minutesLabel).join(', ')}`;
  }
  return `кожні ${s.summaryIntervalMin / 60} год`;
}

function tasksWord(n) {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) return 'справа чекає';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'справи чекають';
  return 'справ чекають';
}

function loadSummaryTasks() {
  return db.getAllSync(
    "SELECT title, deadline FROM tasks WHERE status = 'active' ORDER BY deadline IS NULL, deadline, id"
  );
}

// dayEvents: події того дня, на який заплановане зведення
function summaryContent(list, dayEvents) {
  const lines = list.slice(0, MAX_SUMMARY_LINES).map((t, i) => {
    if (!t.deadline) return `${i + 1}. ${t.title}`;
    const d = new Date(t.deadline);
    return `${i + 1}. ${t.title} · до ${formatDate(d)} ${formatTime(d)}`;
  });
  if (list.length > MAX_SUMMARY_LINES) {
    lines.push(`і ще ${list.length - MAX_SUMMARY_LINES}`);
  }
  const upcoming = dayEvents.slice(0, MAX_SUMMARY_EVENTS);
  if (upcoming.length) {
    if (lines.length) lines.push('');
    lines.push('Сьогодні в календарі:');
    for (const e of upcoming) lines.push(`• ${eventTime(e)} ${e.title}`);
  }
  return {
    title: list.length ? `${list.length} ${tasksWord(list.length)}` : 'Сьогодні в календарі',
    body: lines.join('\n'),
    data: { type: 'summary' },
  };
}

// Події, які ще актуальні на момент зведення: того ж дня і ще не почались
function eventsForSummaryAt(time, events) {
  return events.filter(
    (e) => isSameDay(e.start, time) && (e.allDay || e.start >= time)
  );
}

// ---------- Сповіщення ----------

async function setupNotifications() {
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Нагадування',
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    {
      identifier: 'done',
      buttonTitle: 'Готово',
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'snooze',
      buttonTitle: `Через ${SNOOZE_MIN} хв`,
      options: { opensAppToForeground: true },
    },
  ]);
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert(
      'Сповіщення вимкнені',
      'Без дозволу на сповіщення нагадування не приходитимуть. Увімкни їх у налаштуваннях телефона.'
    );
  }
}

function notificationBody(task) {
  if (!task.deadline) return task.title;
  const d = new Date(task.deadline);
  return `${task.title} · дедлайн ${formatDate(d)} о ${formatTime(d)}`;
}

async function doReschedule() {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of scheduled) {
    if (!n.identifier.startsWith(SNOOZE_PREFIX)) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier);
    }
  }

  const s = loadSettings();
  const active = db.getAllSync(
    "SELECT id, title, created_at, deadline FROM tasks WHERE status = 'active'"
  );

  // Нав'язливі нагадування про завдання: щодня, завжди
  for (const t of active) {
    for (const slot of slotsFor(t.created_at, s)) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: nagTitle(slot.order),
          body: notificationBody(t),
          data: { taskId: t.id },
          categoryIdentifier: CATEGORY_ID,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: slot.hour,
          minute: slot.minute,
          channelId: CHANNEL_ID,
        },
      });
    }
  }

  // Зведення: окремо на кожен день, з подіями саме цього дня
  const slots = summarySlots(s);
  if (slots.length === 0) return;

  const now = new Date();
  const events =
    (await loadEvents(now, endOfDay(addDays(now, SUMMARY_DAYS_AHEAD - 1)), false)) || [];
  const taskList = loadSummaryTasks();

  for (let day = 0; day < SUMMARY_DAYS_AHEAD; day += 1) {
    const date = startOfDay(addDays(now, day));
    for (const m of slots) {
      const time = new Date(date);
      time.setHours(Math.floor(m / 60), m % 60, 0, 0);
      if (time <= now) continue;

      const dayEvents = eventsForSummaryAt(time, events);
      if (taskList.length === 0 && dayEvents.length === 0) continue;

      await Notifications.scheduleNotificationAsync({
        content: summaryContent(taskList, dayEvents),
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: time,
          channelId: CHANNEL_ID,
        },
      });
    }
  }
}

let rescheduleChain = Promise.resolve();
function rescheduleAll() {
  rescheduleChain = rescheduleChain.then(doReschedule).catch(console.warn);
  return rescheduleChain;
}

async function dismissTaskNotifications(taskId) {
  const presented = await Notifications.getPresentedNotificationsAsync();
  for (const n of presented) {
    if (n.request.content.data?.taskId === taskId) {
      await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  }
}

async function cancelSnooze(taskId) {
  try {
    await Notifications.cancelScheduledNotificationAsync(`${SNOOZE_PREFIX}${taskId}`);
  } catch (e) {
    // відкладеного нагадування не було, нічого страшного
  }
}

async function snoozeTask(taskId) {
  const t = db.getFirstSync(
    "SELECT id, title, deadline FROM tasks WHERE id = ? AND status = 'active'",
    taskId
  );
  await dismissTaskNotifications(taskId);
  if (!t) return null;
  await cancelSnooze(taskId);
  await Notifications.scheduleNotificationAsync({
    identifier: `${SNOOZE_PREFIX}${taskId}`,
    content: {
      title: 'Відпочила? Повертаюсь',
      body: notificationBody(t),
      data: { taskId: t.id },
      categoryIdentifier: CATEGORY_ID,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: SNOOZE_MIN * 60,
      channelId: CHANNEL_ID,
    },
  });
  return t;
}

async function completeTask(taskId) {
  const result = db.runSync(
    "UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND status = 'active'",
    new Date().toISOString(),
    taskId
  );
  await dismissTaskNotifications(taskId);
  await cancelSnooze(taskId);
  await rescheduleAll();
  if (result.changes === 0) return null;
  return db.getFirstSync(
    'SELECT id, title, created_at, done_at FROM tasks WHERE id = ?',
    taskId
  );
}

async function undoTask(taskId) {
  db.runSync(
    "UPDATE tasks SET status = 'active', done_at = NULL WHERE id = ?",
    taskId
  );
  await rescheduleAll();
}

async function deleteTask(taskId) {
  db.runSync('DELETE FROM tasks WHERE id = ?', taskId);
  await dismissTaskNotifications(taskId);
  await cancelSnooze(taskId);
  await rescheduleAll();
}

async function sendTestNotification() {
  const t = db.getFirstSync(
    "SELECT id, title, deadline FROM tasks WHERE status = 'active' ORDER BY id DESC"
  );
  if (!t) {
    Alert.alert('Немає завдань', 'Спочатку додай хоча б одне завдання.');
    return;
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${nagTitle(4)} (тест)`,
      body: notificationBody(t),
      data: { taskId: t.id },
      categoryIdentifier: CATEGORY_ID,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 10,
      channelId: CHANNEL_ID,
    },
  });
  Alert.alert('Тест', 'Згорни застосунок, сповіщення прийде через 10 секунд.');
}

async function sendTestSummary() {
  const list = loadSummaryTasks();
  const events = (await loadTodayEvents(false)) || [];
  if (list.length === 0 && events.length === 0) {
    Alert.alert('Немає справ', 'Зведення приходить, тільки коли є завдання або події на сьогодні.');
    return;
  }
  const content = summaryContent(list, events);
  await Notifications.scheduleNotificationAsync({
    content: { ...content, title: `${content.title} (тест)` },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 10,
      channelId: CHANNEL_ID,
    },
  });
  Alert.alert('Тест', 'Згорни застосунок, зведення прийде через 10 секунд.');
}

// ---------- Компоненти ----------

function TimeField({ label, value, onChange }) {
  const open = () => {
    const d = new Date();
    d.setHours(Math.floor(value / 60), value % 60, 0, 0);
    openPicker({
      value: d,
      mode: 'time',
      onPick: (date) => onChange(date.getHours() * 60 + date.getMinutes()),
    });
  };

  return (
    <Pressable style={[styles.timeButton, { flex: 1 }]} onPress={open}>
      <Text style={styles.timeLabel}>{label}</Text>
      <Text style={styles.timeValue}>{minutesLabel(value)}</Text>
      <Text style={styles.timeChange}>Змінити</Text>
    </Pressable>
  );
}

function Chips({ items, value, onChange }) {
  return (
    <View style={styles.chips}>
      {items.map((i) => (
        <Pressable
          key={i.key}
          style={[styles.chip, value === i.key && styles.chipActive]}
          onPress={() => onChange(i.key)}
        >
          <Text style={[styles.chipText, value === i.key && styles.chipTextActive]}>
            {i.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function SettingsScreen({ onBack }) {
  const initial = loadSettings();
  const [intervalMin, setIntervalMin] = useState(initial.intervalMin);
  const [startMin, setStartMin] = useState(initial.startMin);
  const [endMin, setEndMin] = useState(initial.endMin);
  const [summaryEnabled, setSummaryEnabled] = useState(initial.summaryEnabled);
  const [summaryMode, setSummaryMode] = useState(initial.summaryMode);
  const [summaryIntervalMin, setSummaryIntervalMin] = useState(initial.summaryIntervalMin);
  const [summaryTimes, setSummaryTimes] = useState(initial.summaryTimes);

  const updateTime = (index, value) => {
    setSummaryTimes(summaryTimes.map((t, i) => (i === index ? value : t)));
  };

  const removeTime = (index) => {
    setSummaryTimes(summaryTimes.filter((_, i) => i !== index));
  };

  const addTime = () => {
    const last = summaryTimes.length ? Math.max(...summaryTimes) : 540;
    setSummaryTimes([...summaryTimes, Math.min(last + 180, 23 * 60)]);
  };

  const save = () => {
    if (startMin >= endMin) {
      Alert.alert('Помилка', 'Початок має бути раніше, ніж кінець');
      return;
    }
    if (summaryEnabled && summaryMode === 'times' && summaryTimes.length === 0) {
      Alert.alert('Помилка', 'Додай хоча б один час для зведення');
      return;
    }
    const cleanTimes = [...new Set(summaryTimes)].sort((a, b) => a - b);
    setSetting('interval_min', intervalMin);
    setSetting('start_min', startMin);
    setSetting('end_min', endMin);
    setSetting('summary_enabled', summaryEnabled ? 1 : 0);
    setSetting('summary_mode', summaryMode);
    setSetting('summary_interval', summaryIntervalMin);
    setSetting('summary_times', cleanTimes.join(','));
    onBack(true);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.header}>Налаштування</Text>

      <Text style={styles.section}>Нагадувати кожні</Text>
      <Chips
        items={INTERVALS.map((i) => ({ key: i.min, label: i.label }))}
        value={intervalMin}
        onChange={setIntervalMin}
      />

      <Text style={styles.section}>Години нагадувань</Text>
      <TimeField label="З" value={startMin} onChange={setStartMin} />
      <TimeField label="До" value={endMin} onChange={setEndMin} />

      <View style={styles.switchRow}>
        <Text style={[styles.section, { flex: 1, marginTop: 0, marginBottom: 0 }]}>
          Зведення всіх справ
        </Text>
        <Switch value={summaryEnabled} onValueChange={setSummaryEnabled} />
      </View>

      {summaryEnabled && (
        <View>
          <Chips
            items={[
              { key: 'interval', label: 'Кожні N годин' },
              { key: 'times', label: 'У конкретний час' },
            ]}
            value={summaryMode}
            onChange={setSummaryMode}
          />

          {summaryMode === 'interval' && (
            <View>
              <Text style={styles.hint}>
                Від {minutesLabel(startMin)} до {minutesLabel(endMin)}, кожні:
              </Text>
              <Chips
                items={SUMMARY_INTERVALS.map((i) => ({ key: i.min, label: i.label }))}
                value={summaryIntervalMin}
                onChange={setSummaryIntervalMin}
              />
            </View>
          )}

          {summaryMode === 'times' && (
            <View>
              {summaryTimes.map((t, i) => (
                <View key={i} style={styles.timeRow}>
                  <TimeField label={`${i + 1}.`} value={t} onChange={(v) => updateTime(i, v)} />
                  <Pressable
                    style={styles.removeButton}
                    onPress={() => removeTime(i)}
                    accessibilityLabel="Прибрати час"
                  >
                    <Text style={styles.removeText}>✕</Text>
                  </Pressable>
                </View>
              ))}
              {summaryTimes.length < MAX_SUMMARY_TIMES && (
                <Pressable style={styles.addTimeButton} onPress={addTime}>
                  <Text style={styles.timeChange}>+ Додати час</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
      )}

      <Pressable style={styles.saveButton} onPress={save}>
        <Text style={styles.addText}>Зберегти</Text>
      </Pressable>
      <Pressable style={styles.backButton} onPress={() => onBack(false)}>
        <Text style={styles.backText}>Назад без збереження</Text>
      </Pressable>

      <Pressable style={styles.testButton} onPress={sendTestNotification}>
        <Text style={styles.testText}>Тест: нагадування через 10 секунд</Text>
      </Pressable>
      <Pressable style={styles.testButton} onPress={sendTestSummary}>
        <Text style={styles.testText}>Тест: зведення через 10 секунд</Text>
      </Pressable>
      <StatusBar style="dark" />
    </ScrollView>
  );
}

// ---------- Головний екран ----------

export default function App() {
  const [screen, setScreen] = useState('tasks');
  const [kind, setKind] = useState('task');
  const [text, setText] = useState('');

  const [deadlineMode, setDeadlineMode] = useState('none');
  const [deadline, setDeadline] = useState(null);
  const [editing, setEditing] = useState(null);

  const [eventStart, setEventStart] = useState(nextFullHour);
  const [eventEnd, setEventEnd] = useState(() => new Date(nextFullHour().getTime() + 3600000));
  const [eventReminder, setEventReminder] = useState(30);
  const [events, setEvents] = useState(undefined);

  const [lastDone, setLastDone] = useState(null);
  const [infoMsg, setInfoMsg] = useState(null);
  const [tasks, setTasks] = useState(loadTasks);
  const [settings, setSettings] = useState(loadSettings);

  const showDone = (task) => {
    if (!task) return;
    setLastDone({ id: task.id, title: task.title, summary: doneSummary(task) });
  };

  const refreshEvents = async (ask) => {
    setEvents(await loadTodayEvents(ask));
  };

  useEffect(() => {
    const handleResponse = async (response) => {
      const taskId = response?.notification.request.content.data?.taskId;
      if (!taskId) return;
      if (response.actionIdentifier === 'done') {
        showDone(await completeTask(taskId));
        setTasks(loadTasks());
      } else if (response.actionIdentifier === 'snooze') {
        const t = await snoozeTask(taskId);
        if (t) setInfoMsg(`«${t.title}» нагадаю через ${SNOOZE_MIN} хв`);
      }
    };

    setupNotifications().then(rescheduleAll);
    refreshEvents(false);
    Notifications.getLastNotificationResponseAsync().then(handleResponse);
    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);

    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refreshEvents(false);
        setTasks(loadTasks());
        rescheduleAll();
      }
    });

    return () => {
      sub.remove();
      appSub.remove();
    };
  }, []);

  useEffect(() => {
    if (!lastDone) return undefined;
    const timer = setTimeout(() => setLastDone(null), UNDO_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [lastDone]);

  useEffect(() => {
    if (!infoMsg) return undefined;
    const timer = setTimeout(() => setInfoMsg(null), 4000);
    return () => clearTimeout(timer);
  }, [infoMsg]);

  if (screen === 'settings') {
    return (
      <SettingsScreen
        onBack={(changed) => {
          setSettings(loadSettings());
          if (changed) rescheduleAll();
          setScreen('tasks');
        }}
      />
    );
  }

  // ----- Завдання -----

  const keptHours = deadline ? deadline.getHours() : 18;
  const keptMinutes = deadline ? deadline.getMinutes() : 0;

  const chooseDay = (key) => {
    if (key === 'none') {
      setDeadlineMode('none');
      setDeadline(null);
      return;
    }

    if (key === 'pick') {
      openPicker({
        value: deadline ?? new Date(),
        mode: 'date',
        minimumDate: new Date(),
        onPick: (date) => {
          const d = new Date(date);
          d.setHours(keptHours, keptMinutes, 0, 0);
          setDeadline(d);
          setDeadlineMode('pick');
        },
      });
      return;
    }

    const d = key === 'tomorrow' ? addDays(new Date(), 1) : new Date();
    d.setHours(keptHours, keptMinutes, 0, 0);
    setDeadline(d);
    setDeadlineMode(key);
  };

  const pickTime = () => {
    openPicker({
      value: deadline,
      mode: 'time',
      onPick: (date) => {
        const d = new Date(deadline);
        d.setHours(date.getHours(), date.getMinutes(), 0, 0);
        setDeadline(d);
      },
    });
  };

  const resetForm = () => {
    setText('');
    setDeadlineMode('none');
    setDeadline(null);
    setEditing(null);
    const start = nextFullHour();
    setEventStart(start);
    setEventEnd(new Date(start.getTime() + 3600000));
    Keyboard.dismiss();
  };

  const startEdit = (item) => {
    const d = item.deadline ? new Date(item.deadline) : null;
    setKind('task');
    setEditing({ id: item.id, originalDeadline: item.deadline });
    setText(item.title);
    setDeadline(d);
    setDeadlineMode(modeForDate(d));
  };

  const saveTask = () => {
    const title = text.trim();
    if (!title) return;

    const deadlineIso = deadline ? deadline.toISOString() : null;
    const deadlineChanged = !editing || deadlineIso !== editing.originalDeadline;
    if (deadline && deadline < new Date() && deadlineChanged) {
      Alert.alert('Цей час уже минув', 'Обери пізніший час або інший день.');
      return;
    }

    if (editing) {
      db.runSync(
        'UPDATE tasks SET title = ?, deadline = ? WHERE id = ?',
        title,
        deadlineIso,
        editing.id
      );
    } else {
      db.runSync(
        'INSERT INTO tasks (title, created_at, deadline) VALUES (?, ?, ?)',
        title,
        new Date().toISOString(),
        deadlineIso
      );
    }
    setTasks(loadTasks());
    resetForm();
    rescheduleAll();
  };

  const confirmDelete = () => {
    const id = editing.id;
    Alert.alert('Видалити завдання?', text.trim(), [
      { text: 'Скасувати', style: 'cancel' },
      {
        text: 'Видалити',
        style: 'destructive',
        onPress: async () => {
          await deleteTask(id);
          setTasks(loadTasks());
          resetForm();
        },
      },
    ]);
  };

  const doneTask = async (id) => {
    if (editing?.id === id) resetForm();
    showDone(await completeTask(id));
    setTasks(loadTasks());
  };

  const undoLast = async () => {
    const id = lastDone.id;
    setLastDone(null);
    await undoTask(id);
    setTasks(loadTasks());
  };

  // ----- Подія -----

  const chooseEventDay = (key) => {
    if (key === 'pick') {
      openPicker({
        value: eventStart,
        mode: 'date',
        minimumDate: new Date(),
        onPick: (date) => {
          setEventStart(withDay(eventStart, date));
          setEventEnd(withDay(eventEnd, date));
        },
      });
      return;
    }
    const day = key === 'tomorrow' ? addDays(new Date(), 1) : new Date();
    setEventStart(withDay(eventStart, day));
    setEventEnd(withDay(eventEnd, day));
  };

  const pickEventTime = (which) => {
    const current = which === 'start' ? eventStart : eventEnd;
    openPicker({
      value: current,
      mode: 'time',
      onPick: (date) => {
        const d = new Date(current);
        d.setHours(date.getHours(), date.getMinutes(), 0, 0);
        if (which === 'start') {
          setEventStart(d);
          if (eventEnd <= d) setEventEnd(new Date(d.getTime() + 3600000));
        } else {
          setEventEnd(d);
        }
      },
    });
  };

  const saveEvent = async () => {
    const title = text.trim();
    if (!title) return;

    if (eventStart < new Date()) {
      Alert.alert('Цей час уже минув', 'Обери пізніший час або інший день.');
      return;
    }
    if (eventEnd <= eventStart) {
      Alert.alert('Помилка', 'Кінець події має бути пізніше за початок.');
      return;
    }

    try {
      if (!(await hasCalendarPermission(true))) {
        Alert.alert(
          'Немає доступу до календаря',
          'Щоб додавати події, дозволь доступ до календаря в налаштуваннях телефона.'
        );
        return;
      }
      const calendar = await getMainCalendar();
      if (!calendar) {
        Alert.alert(
          'Календар не знайдено',
          'Додай Google акаунт у налаштуваннях телефона, щоб записувати події.'
        );
        return;
      }
      await Calendar.createEventAsync(calendar.id, {
        title,
        startDate: eventStart,
        endDate: eventEnd,
        timeZone: TIME_ZONE,
        alarms: [{ relativeOffset: -eventReminder, method: Calendar.AlarmMethod.ALERT }],
      });
      setInfoMsg(`Подію додано в календар «${calendar.title}»`);
      resetForm();
      await refreshEvents(false);
      rescheduleAll();
    } catch (e) {
      console.warn(e);
      Alert.alert('Не вдалося додати подію', String(e?.message ?? e));
    }
  };

  // ----- Екран -----

  const isEvent = kind === 'event';

  const eventsBlock = (
    <View>
      <Text style={styles.section}>Сьогодні в календарі</Text>
      {events === null && (
        <Pressable style={styles.permissionButton} onPress={() => refreshEvents(true)}>
          <Text style={styles.timeChange}>Показати події з календаря</Text>
        </Pressable>
      )}
      {Array.isArray(events) && events.length === 0 && (
        <Text style={styles.hint}>На сьогодні подій більше немає</Text>
      )}
      {Array.isArray(events) &&
        events.map((e) => (
          <View key={e.key} style={styles.eventRow}>
            <View style={styles.eventBadge}>
              <Text style={styles.eventBadgeText}>{eventTime(e)}</Text>
            </View>
            <Text style={[styles.taskText, { flex: 1 }]}>{e.title}</Text>
          </View>
        ))}
      <Text style={styles.section}>Завдання</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Мої завдання</Text>

      <Pressable onPress={() => setScreen('settings')}>
        <Text style={styles.settingsLink}>
          Нагадування: кожні {intervalLabel(settings.intervalMin)}, з {minutesLabel(settings.startMin)} до {minutesLabel(settings.endMin)}.
          {'\n'}Зведення: {summaryLabel(settings)}. Змінити
        </Text>
      </Pressable>

      {editing ? (
        <Text style={styles.editTitle}>Редагування завдання</Text>
      ) : (
        <Chips items={KINDS} value={kind} onChange={setKind} />
      )}

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          placeholder={isEvent ? 'Назва події' : 'Що треба зробити?'}
          value={text}
          onChangeText={setText}
          onSubmitEditing={isEvent ? saveEvent : saveTask}
        />
        <Pressable
          style={[styles.addButton, isEvent && styles.eventButton]}
          onPress={isEvent ? saveEvent : saveTask}
        >
          <Text style={styles.addText}>{editing ? 'Зберегти' : 'Додати'}</Text>
        </Pressable>
      </View>

      {!isEvent && (
        <View>
          <Chips
            items={DEADLINE_DAYS.map((d) => ({
              key: d.key,
              label: d.key === 'pick' && deadlineMode === 'pick' && deadline ? formatDate(deadline) : d.label,
            }))}
            value={deadlineMode}
            onChange={chooseDay}
          />
          {deadline && (
            <Pressable style={styles.timeButton} onPress={pickTime}>
              <Text style={styles.timeLabel}>Дедлайн о</Text>
              <Text style={styles.timeValue}>{formatTime(deadline)}</Text>
              <Text style={styles.timeChange}>Змінити час</Text>
            </Pressable>
          )}
        </View>
      )}

      {isEvent && (
        <View>
          <Chips
            items={EVENT_DAYS.map((d) => ({
              key: d.key,
              label: d.key === 'pick' && modeForDate(eventStart) === 'pick' ? formatDate(eventStart) : d.label,
            }))}
            value={modeForDate(eventStart)}
            onChange={chooseEventDay}
          />
          <View style={styles.row}>
            <Pressable style={[styles.timeButton, styles.halfTime]} onPress={() => pickEventTime('start')}>
              <Text style={styles.timeLabel}>Початок</Text>
              <Text style={styles.timeValue}>{formatTime(eventStart)}</Text>
            </Pressable>
            <Pressable style={[styles.timeButton, styles.halfTime, { marginRight: 0 }]} onPress={() => pickEventTime('end')}>
              <Text style={styles.timeLabel}>Кінець</Text>
              <Text style={styles.timeValue}>{formatTime(eventEnd)}</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>Нагадати:</Text>
          <Chips items={EVENT_REMINDERS} value={eventReminder} onChange={setEventReminder} />
        </View>
      )}

      {editing && (
        <View style={styles.editActions}>
          <Pressable style={styles.deleteButton} onPress={confirmDelete}>
            <Text style={styles.deleteText}>Видалити</Text>
          </Pressable>
          <Pressable style={styles.cancelButton} onPress={resetForm}>
            <Text style={styles.cancelText}>Скасувати</Text>
          </Pressable>
        </View>
      )}

      <FlatList
        style={{ marginTop: 4 }}
        contentContainerStyle={{ paddingBottom: 100 }}
        data={tasks}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={eventsBlock}
        ListEmptyComponent={<Text style={styles.hint}>Завдань немає</Text>}
        renderItem={({ item }) => {
          const info = deadlineInfo(item.deadline);
          const isEditing = editing?.id === item.id;
          return (
            <View style={[styles.task, isEditing && styles.taskEditing]}>
              <Pressable style={{ flex: 1 }} onPress={() => startEdit(item)}>
                <Text style={styles.taskText}>{item.title}</Text>
                {info && (
                  <Text style={[styles.deadline, info.overdue && styles.deadlineOverdue]}>
                    {info.text}
                  </Text>
                )}
              </Pressable>
              <Pressable style={styles.doneButton} onPress={() => doneTask(item.id)}>
                <Text style={styles.doneText}>Готово</Text>
              </Pressable>
            </View>
          );
        }}
      />

      {infoMsg && !lastDone && (
        <View style={styles.snackbar}>
          <Text style={[styles.snackTitle, { flex: 1, paddingVertical: 8 }]}>{infoMsg}</Text>
        </View>
      )}

      {lastDone && (
        <View style={styles.snackbar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.snackTitle}>Виконано: {lastDone.title}</Text>
            <Text style={styles.snackSummary}>{lastDone.summary}</Text>
          </View>
          <Pressable style={styles.undoButton} onPress={undoLast}>
            <Text style={styles.undoText}>Повернути</Text>
          </Pressable>
        </View>
      )}
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 60, paddingHorizontal: 16 },
  screen: { flex: 1, backgroundColor: '#fff' },
  scrollContent: { paddingTop: 60, paddingHorizontal: 16, paddingBottom: 40 },
  header: { fontSize: 26, fontWeight: 'bold', marginBottom: 8 },
  settingsLink: { color: '#2563eb', marginBottom: 12, lineHeight: 20 },
  editTitle: { fontSize: 14, fontWeight: 'bold', color: '#b45309', marginBottom: 8 },
  row: { flexDirection: 'row', marginBottom: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16 },
  addButton: { backgroundColor: '#2563eb', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center', marginLeft: 8 },
  eventButton: { backgroundColor: '#4338CA' },
  addText: { color: '#fff', fontWeight: 'bold' },
  task: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, borderColor: '#eee', borderRadius: 8, marginBottom: 8 },
  taskEditing: { borderColor: '#f59e0b', borderWidth: 2 },
  taskText: { fontSize: 16 },
  deadline: { fontSize: 13, color: '#b45309', marginTop: 4 },
  deadlineOverdue: { color: '#b42318', fontWeight: 'bold' },
  doneButton: { backgroundColor: '#16a34a', borderRadius: 6, paddingVertical: 6, paddingHorizontal: 12, marginLeft: 8 },
  doneText: { color: '#fff' },
  editActions: { flexDirection: 'row', marginBottom: 8 },
  deleteButton: { flex: 1, borderWidth: 1, borderColor: '#b42318', borderRadius: 8, padding: 12, alignItems: 'center', marginRight: 8 },
  deleteText: { color: '#b42318', fontWeight: 'bold' },
  cancelButton: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, alignItems: 'center' },
  cancelText: { color: '#333' },
  eventRow: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 8, backgroundColor: '#EEF2FF', marginBottom: 8 },
  eventBadge: { backgroundColor: '#4338CA', borderRadius: 6, paddingVertical: 4, paddingHorizontal: 8, marginRight: 12, minWidth: 56, alignItems: 'center' },
  eventBadgeText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  permissionButton: { padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#2563eb', borderStyle: 'dashed', borderRadius: 8, marginBottom: 8 },
  halfTime: { flex: 1, marginRight: 8, marginBottom: 0 },
  snackbar: { position: 'absolute', left: 16, right: 16, bottom: 32, flexDirection: 'row', alignItems: 'center', backgroundColor: '#16181D', borderRadius: 12, paddingVertical: 10, paddingLeft: 16, paddingRight: 8 },
  snackTitle: { color: '#fff', fontWeight: 'bold' },
  snackSummary: { color: '#C9CCD4', fontSize: 13, marginTop: 2 },
  undoButton: { paddingVertical: 10, paddingHorizontal: 12 },
  undoText: { color: '#FDBA74', fontWeight: 'bold' },
  section: { fontSize: 16, fontWeight: 'bold', marginTop: 12, marginBottom: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 24, marginBottom: 8 },
  hint: { color: '#555', marginBottom: 8 },
  timeRow: { flexDirection: 'row', alignItems: 'flex-start' },
  removeButton: { width: 48, height: 52, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  removeText: { fontSize: 18, color: '#b42318' },
  addTimeButton: { padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#2563eb', borderStyle: 'dashed', borderRadius: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: '#2563eb', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14, marginRight: 8, marginBottom: 8 },
  chipActive: { backgroundColor: '#2563eb' },
  chipText: { color: '#2563eb' },
  chipTextActive: { color: '#fff' },
  timeButton: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, marginBottom: 8 },
  timeLabel: { fontSize: 15, color: '#555', minWidth: 40 },
  timeValue: { fontSize: 20, fontWeight: 'bold', marginLeft: 8, flex: 1 },
  timeChange: { color: '#2563eb' },
  saveButton: { backgroundColor: '#2563eb', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 24 },
  backButton: { padding: 14, alignItems: 'center' },
  backText: { color: '#666' },
  testButton: { borderWidth: 1, borderColor: '#f59e0b', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 12 },
  testText: { color: '#b45309' },
});