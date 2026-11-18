<?php
require_once 'config.php';

$db = new mysqli('localhost', 'blog', getenv('DB_PASS'), 'blog');
$pdo = new PDO('mysql:host=localhost;dbname=blog', 'blog', getenv('DB_PASS'));

$action = $_GET['action'] ?? 'list';

if ($action === 'view') {
    $id = $_GET['id'];
    $res = $db->query("SELECT * FROM posts WHERE id = " . $id); // EXPECT: S2 sqli
    $safeId = intval($_GET['id']);
    $res2 = $db->query("SELECT * FROM posts WHERE id = " . $safeId); // SAFE: S2
    $stmt = $pdo->prepare('SELECT * FROM posts WHERE id = ?'); // SAFE: S2
    $stmt->execute([$id]);
}

if ($action === 'search') {
    $q = $_GET['q'];
    echo "<h2>Search results for " . $q . "</h2>"; // EXPECT: S2 xss
    echo "<h2>Search results for " . htmlspecialchars($q, ENT_QUOTES) . "</h2>"; // SAFE: S2
    $rows = mysqli_query($db, "SELECT * FROM posts WHERE title LIKE '%$q%'"); // EXPECT: S2 sqli
}

if ($action === 'page') {
    $page = $_GET['page'];
    include 'pages/' . $page . '.php'; // EXPECT: S2 file-inclusion
    include 'pages/' . basename($page) . '.php'; // SAFE: S2
}

if ($action === 'download') {
    $f = $_GET['file'];
    readfile('/var/www/uploads/' . $f); // EXPECT: S2 path
    readfile('/var/www/uploads/' . basename($f)); // SAFE: S2
}

if ($action === 'ping') {
    $host = $_POST['host'];
    echo shell_exec('ping -c 1 ' . $host); // EXPECT: S2 cmd
    echo shell_exec('ping -c 1 ' . escapeshellarg($host)); // SAFE: S2
}

if ($action === 'fetch') {
    $url = $_GET['url'];
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url); // EXPECT: S2 ssrf
    curl_exec($ch);
}

if ($action === 'prefs') {
    $prefs = unserialize($_COOKIE['prefs']); // EXPECT: S2 deserialization
    $prefs2 = json_decode($_COOKIE['prefs'], true); // SAFE: S2
}

if ($action === 'calc') {
    $expr = $_GET['expr'];
    eval('$result = ' . $expr . ';'); // EXPECT: S2 code-injection
}

if ($action === 'login') {
    $password = $_POST['password'];
    $hash = md5($password); // EXPECT: S8 weak-hash
    $good = password_hash($password, PASSWORD_DEFAULT); // SAFE: S8
    $next = $_GET['next'];
    header('Location: ' . $next); // EXPECT: S2 open-redirect
    header('Location: /dashboard'); // SAFE: S2
}

$etag = md5(file_get_contents('style.css')); // SAFE: S8
