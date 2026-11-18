<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;

class UserController extends Controller
{
    public function index(Request $request)
    {
        $order = $request->input('order', 'id');
        $users = DB::select("SELECT * FROM users ORDER BY " . $order); // EXPECT: S2 sqli
        $role = $request->input('role');
        $admins = DB::select('SELECT * FROM users WHERE role = ?', [$role]); // SAFE: S2
        return view('users.index', ['users' => $users]);
    }

    public function search(Request $request)
    {
        $term = $request->query('q');
        $users = User::whereRaw("name LIKE '%" . $term . "%'")->get(); // EXPECT: S2 sqli
        $safe = User::where('name', 'like', '%' . $term . '%')->get(); // SAFE: S2
        return response()->json($users);
    }

    public function avatar(Request $request)
    {
        $file = $request->get('file');
        return response()->download(storage_path('avatars/' . $file)); // EXPECT: S2 path
    }

    public function avatarSafe(Request $request)
    {
        $file = basename($request->get('file'));
        return response()->download(storage_path('avatars/' . $file)); // SAFE: S2
    }

    public function import(Request $request)
    {
        $source = $request->input('source_url');
        $resp = Http::get($source); // EXPECT: S2 ssrf
        $data = unserialize($request->input('payload')); // EXPECT: S2 deserialization
        return response()->json(['ok' => true]);
    }

    public function backup(Request $request)
    {
        $db = $request->input('database');
        exec("mysqldump " . $db . " > /tmp/backup.sql"); // EXPECT: S2 cmd
        return 'done';
    }

    public function greet(Request $request)
    {
        $name = $request->input('name');
        echo "<p>Welcome back, " . $name . "</p>"; // EXPECT: S2 xss
        echo "<p>Welcome back, " . e($name) . "</p>"; // SAFE: S2
    }

    public function logout(Request $request)
    {
        $to = $request->query('to');
        return redirect($to); // EXPECT: S2 open-redirect
    }

    public function legacyLogin(Request $request)
    {
        $pwd = $request->input('password');
        $user = User::where('email', $request->input('email'))->first();
        if ($user && $user->password === sha1($pwd)) { // EXPECT: S8 weak-hash
            return 'ok';
        }
        return 'fail';
    }

    public function cacheKey(Request $request)
    {
        return md5($request->fullUrl()); // SAFE: S8
    }
}
